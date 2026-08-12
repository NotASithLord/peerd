// @ts-check
// DESIGN-17 — message_actor: the channel to a tab-hosted instance's actor.
//
// You don't mutate an instance; you message its ACTOR — a GenServer-style OTP
// process (started on demand, addressed by a registered name, the resolved actor
// session its live PID) that exclusively holds that environment's tools. This
// orchestrator is the direct analog of async-actors (actor/async-actors.js):
// a MAILBOX over turnSlots processed one message at a time (never interrupts an
// in-flight turn), a SW-captured correlation (the sender is closed over, not trusted
// from the actor), a wrapUntrusted-fenced reply that re-enters the sender as a
// synthetic wake, and a per-sender runaway guard. Functional core / imperative shell:
// every IO surface is injected, so the spawn → run → reply flow is unit-testable.
//
// ONE reply shape for EVERY kind (web included). The orchestrator does not block BY
// DEFAULT: it hands a task to an actor and gets woken with the reply on a later turn
// via deliver()/runWhenIdle — the actor model, uniformly. The one exception is the
// opt-in `await:true` (message_actor), which resolves the fenced reply into the tool
// result so the orchestrator can answer in the SAME turn instead of deferring; it is
// bounded by a wall-clock cap that degrades back to the later-turn wake, so even the
// blocking shape cannot park a turn indefinitely or drop a reply. The actor's own turn slot
// serializes its turns (one actor per tab/instance); deliver() wrapUntrusted-
// fences the reply, so a web actor's page-derived reply is fenced like any other
// untrusted content. (Web used to be a sync-await special case — collapsed into
// this path; it never blocked the orchestrator, and the fence is now uniform.)
//
// Durable mailbox (P1). The correlation is persisted (deps.mailbox): an SW death
// between accept and deliver() no longer drops the reply-wake. Each entry is
// persisted as queued, then moved to started before actor work can begin. Boot
// recovery never executes a stored request automatically. Queued work is reported
// as Not run; started or legacy work is reported as outcome unknown. The default
// no-op mailbox keeps pure-heap tests lightweight.
//
// Posture (PR #134 — spawned as async actors): a message is accepted when the
// turn is NOT `inbound` AND the sender passes the TRUSTED-LINEAGE gate
// (delegation-lineage.js mayMessageActor): the active foreground chat, or a
// descendant of it reached entirely through trusted spawn edges (spawn.js
// stamps `spawnedTrusted` per hop; one inbound spawn taints its subtree).
// `inbound` is the untrusted-ORIGIN signal the turn driver folds from
// synthetic + trusted: `inbound = synthetic && !trusted`. So a real user turn,
// an explicit first-party continuation (a goal turn, or the orchestrator
// reacting to an actor's reply — both set trusted:true), and a trusted-lineage
// actor MAY delegate; an untrusted/external synthetic turn (future peer
// messages / scheduled tasks — never trusted) is refused. Fail-CLOSED: a
// missing/unwalkable ancestry admits only the foreground chat itself.
//
// The runaway guard + Stop bookkeeping are keyed by the lineage ROOT
// (messageProvenance) rather than the raw sender, so a parent↔child↔actor
// cycle shares ONE budget (phase 4) and a user Stop on the chat cascades to
// actor turns its descendants started (phase 5). Envelopes (durable mailbox
// entries) carry the provenance so a boot redrain can arbitrate: a reply whose
// awaiting sender was an EPHEMERAL actor (dead after restart) is rerouted
// to the root instead of waking a headless child (phase 7).
//
// Reply modes: the ORCHESTRATOR (and any long-lived chat session) gets the
// async wake — deliver() re-enters it on a later turn. A ACTOR sender sets
// `awaitReply`: it is a fire-once call-site with no later turn, so its reply
// resolves INTO the message_actor tool result (still wrapUntrusted-fenced).
// why not wake an actor like a chat: the reenter path runs sessions under
// the SW's main turn driver — waking a finished child would both run an
// orphan turn nobody consumes AND rebuild its context on the MAIN exposure
// surface, escalating past the child's narrowed toolset.

import { escapeAttr } from '/shared/util.js';
import { ASYNC_ACTOR_ACTORS, mayMessageActor, messageProvenance } from './delegation-lineage.js';
// #241 — the deterministic schema boundary for an untrusted actor's reply.
// Pure policy (no IO), imported directly like the other pure helpers here; the
// FLAG that turns it on is injected (schemaValidatedReplies), SW-side.
import { validateActorReply, renderValidatedReply, REPLY_VALIDATION_FAILED } from './reply-schema.js';
import { ABORT_STEER } from '../loop/turn-slots.js';
import { actorIsolationAvailable, actorIsolationRefusal } from './isolation.js';

/**
 * The reason a turn's abort signal carries, when it carries one.
 *
 * why a helper rather than reading `signal.reason` inline: awaitSignal is
 * duck-typed — the real one is an AbortSignal, but spawn.js and the tests pass
 * stubs that implement only `aborted` + the listener pair, where the property is
 * absent entirely.
 *
 * Only an explicit ABORT_STEER opts into the degrade path. Everything else falls
 * through to cancel: an untagged `abort()` (whose reason is the platform's own
 * AbortError), ABORT_STOP, and a stub's undefined alike. That direction is the
 * safe one — cancelling is what every abort meant before reasons existed, so a
 * caller this file has not been taught about keeps the old semantics rather than
 * silently leaving an actor running that the user meant to kill.
 *
 * @param {{ reason?: unknown } | null | undefined} signal
 * @returns {unknown}
 */
const abortReasonOf = (signal) => {
  try { return signal?.reason; } catch { return undefined; }
};

// The actor kinds whose reply is UNTRUSTED web content and so must cross the
// deterministic schema boundary when it's enabled. Engine sandboxes (vm/notebook/
// app) return the agent's OWN compute and keep the free-form path; the web + API
// actors ingest hostile page/response bytes — those are the ones to structure.
//
// Two honest notes on this set, so the next reader doesn't mistake it for a
// finished policy:
//   - 'api' is belt-and-braces. An API integration resolves to kind 'web' with
//     backing 'api' (the SW's actor resolver), so nothing reaches here as 'api'
//     today. It stays because the PROMPT half narrows on actorType === 'web',
//     which covers both backings — dropping 'api' would make the two halves
//     disagree the moment a resolver changes.
//   - 'dweb' is deliberately ABSENT and arguably should not be. The dweb actor
//     ingests inbound peer DMs and A2A output — as untrusted as page bytes.
//     It is excluded only because it is preview-only and its reply shape has
//     not been exercised against the envelope; extending the set is a follow-up
//     that needs its own prompt half, not a one-word edit here.
const SCHEMA_VALIDATED_KINDS = new Set(['web', 'api']);

/**
 * @param {Object} deps
 * @param {(instanceId: string, opts?: { senderSessionId?: string | null }) => Promise<{ instanceId: string, kind: string, actorSessionId: string, name?: string, tabId?: number } | { resolutionRefusal: { ok: false, error: string, content?: string, structured?: Record<string, unknown>, outcomeKind?: 'pre-effect-failure' } } | null>} deps.resolveActor
 *   Resolve an instance id to its (lazily-minted) actor. Returns null when no
 *   instance with that id exists across the three registries. `senderSessionId` is the
 *   chat that sent this message — the chat-scoped WEB actor (to:'web') is owned by it,
 *   so it must be threaded (not re-derived from the ambient active chat, which is wrong
 *   on a boot redrain). Engine/per-tab kinds ignore it (globally/tab keyed).
 * @param {(opts: { actorSessionId: string, message: string, actorTabId?: number, instanceId: string, kind: string, correlationId: string, parentToolUseId?: string, parentSessionId: string, rootSessionId: string, name?: string, oneShot?: boolean, turnLease?: { controller: AbortController, release: () => void } }) => Promise<{ result: string, stopped?: boolean, aborted?: boolean, performed?: boolean, executionFailed?: boolean, outcomeKnown?: boolean, isolationFailure?: { performed?: boolean, outcomeKnown?: boolean, aborted?: boolean } }>} deps.runActorTurn
 *   Drive ONE actor turn (runAgentTurn against the actor session) and
 *   resolve with its final assistant text. correlationId is the durable mailbox
 *   identity; parentToolUseId keys the actor's live DISPLAY stream to its card.
 *   Contracted to CLAIM the actor's
 *   turn slot (so runWhenIdle drains correctly).
 * @param {(opts: { userText: string, sessionId: string, synthetic: boolean, trusted?: boolean, actorReply?: { kind: string, instanceId: string, name?: string, failed: boolean, outcomeKnown?: boolean, performed?: boolean, aborted?: boolean, actorDeliveryId?: string, parentToolUseId?: string }, turnLease?: { controller: AbortController, release: () => void } }) => Promise<unknown>} deps.reenter
 *   Re-enter a session with a (synthetic) turn — the SW's runAgentTurn. trusted:true
 *   marks a first-party continuation allowed to message actors (the reply-wake).
 * @param {(opts: { userText: string, sessionId: string, synthetic: true, actorReply: { kind: string, instanceId: string, name?: string, failed: boolean, outcomeKnown?: boolean, performed?: boolean, aborted?: boolean, actorDeliveryId?: string, parentToolUseId?: string }, recoveryId: string }) => Promise<boolean>} [deps.recordRecovery]
 *   Persist a restart notice without running a model turn. The shell gives the
 *   notice a stable id derived from recoveryId, making a second restart safe.
 * @param {(opts: { sessionId: string, deliveryId: string }) => Promise<boolean>} [deps.deliveryCommitted]
 *   Check whether the original reply or outer tool result is already durable.
 *   Recovery removes that mailbox row without adding a second warning.
 * @param {{ runWhenIdle: (sessionId: string, fn: () => void) => void, runWhenIdleClaimed?: (sessionId: string, fn: (lease: { controller: AbortController, release: () => void }) => void) => void, advanceQueue?: (sessionId: string) => void, stop?: (sessionId: string) => boolean }} deps.turnSlots
 * @param {(actorSessionId: string) => boolean | Promise<boolean>} [deps.isActorSessionCurrent]
 *   Revalidate a resolved actor at its dequeue boundary. A stopped roaming web
 *   actor is durably retired while another delivery may already be waiting on
 *   its slot; that queued closure must not run the retired session transcript.
 * @param {() => Promise<string | null>} deps.getActiveSessionId
 * @param {(sessionId: string) => Promise<Array<import('./delegation-lineage.js').LineageHop>>} [deps.getAncestry]
 * @param {() => boolean} [deps.schemaValidatedReplies] issue 241 - force an untrusted (web/api) actor's reply through the strict JSON envelope validator before it reaches the orchestrator. Read PER REPLY (a getter, not a boolean) so flipping the setting takes effect without an SW restart. Default `() => false` (free-form fenced path).
 *   Build the sender's lineage chain (sender-first toward the root) from the
 *   session store — the shell walk mayMessageActor/messageProvenance read.
 *   Default returns [] — FAIL-CLOSED: without a chain only the foreground chat
 *   itself passes the gate, and provenance collapses to the sender.
 * @param {() => boolean} deps.isVaultLocked
 * @param {() => import('./isolation.js').ActorIsolationCapability | null} [deps.getActorIsolation]
 * @param {(opts: { origin: string, tool: string, body: string, retrievedAt?: string }) => string} deps.wrapUntrusted
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.makeCorrelationId]
 * @param {{ outstanding?: number, rateCap?: number, rateWindowMs?: number, resultChars?: number }} [deps.caps]
 * @param {(...args: unknown[]) => void} [deps.log]
 * @param {{ append: (e: { id: string, senderSessionId: string, to: string, message: string, createdAt: number, state?: 'queued'|'started', kind?: string, name?: string, parentToolUseId?: string, provenance?: { rootSessionId: string, lineagePath: string[] }, oneShot?: boolean }) => Promise<unknown>, markStarted?: (id: string) => Promise<unknown>, remove: (id: string) => Promise<unknown>, load: () => Promise<any[]> }} [deps.mailbox]
 *   DURABLE MAILBOX (DESIGN-17 P1). Persists EVERY actor's in-flight
 *   message→reply correlation — web included — so an SW death between accept and
 *   deliver() doesn't silently drop the reply-wake. append() records queued,
 *   markStarted() commits the no-replay boundary before dispatch, remove() runs
 *   after reply delivery, and load() feeds boot recovery. Mirrors goal-runner
 *   persistence.
 */
export const makeActorMessaging = (deps) => {
  const {
    resolveActor, runActorTurn, reenter, turnSlots,
    getActiveSessionId, isVaultLocked, wrapUntrusted,
    isActorSessionCurrent = async () => true,
    getActorIsolation = () => null,
    getAncestry = async () => [],
    // #241 — when this reads true, an untrusted actor's (web/api) reply must be a
    // strict JSON envelope, validated by deterministic code before it reaches the
    // orchestrator; a non-conforming reply is DROPPED for a fixed notice. Default
    // OFF (the free-form fenced path).
    //
    // why a GETTER and not a boolean: deps are destructured ONCE, at construction,
    // and makeActorMessaging is built at SW boot. A boolean would freeze at its
    // boot value and silently ignore the user flipping the setting. The prompt
    // half has the same property for free (ctx.schemaReply is stamped per turn),
    // so reading per reply is what keeps the two halves ONE switch.
    schemaValidatedReplies = () => false,
    recordRecovery = async () => false,
    deliveryCommitted = async () => false,
    appendAudit = async () => {}, now = Date.now,
    makeCorrelationId = () => globalThis.crypto.randomUUID(),
    caps = {}, log = () => {},
    mailbox: mailboxInput = {},
  } = deps;
  const mailbox = {
    append: async (/** @type {any} */ _entry) => {},
    markStarted: async (/** @type {string} */ _id) => {},
    remove: async (/** @type {string} */ _id) => {},
    load: async () => /** @type {any[]} */ ([]),
    ...mailboxInput,
  };

  // The kinds oneShot is honored for — the agent's OWN engine sandboxes, whose
  // raw results are (relatively) trusted instance output. Never web/api/dweb.
  const ONESHOT_KINDS = new Set(['webvm', 'notebook', 'pod', 'app']);

  const OUTSTANDING_CAP = caps.outstanding ?? 4;
  const RATE_CAP = caps.rateCap ?? 8;
  const RATE_WINDOW_MS = caps.rateWindowMs ?? 60_000;
  const RESULT_CHARS = caps.resultChars ?? 16 * 1024;

  // PR #134 phase 4: ALL of the bookkeeping below is keyed by the lineage ROOT
  // (messageProvenance.rootSessionId — the chat at the base of the sender's
  // lineage), not the raw sender. One budget bounds a whole delegation graph
  // (a parent↔child↔actor cycle can't multiply its caps by fanning out), and
  // stopActorsFor(chatId) — the user's Stop, which only knows the CHAT id —
  // reaches actor turns that a descendant actor started. For a plain chat
  // sender, root === sender, so the pre-#134 behavior is unchanged.
  /** @type {Map<string, number>} rootSessionId → actor messages currently in flight */
  const inFlight = new Map();
  // Settled actor replies that still await a parent wake or a passive durable
  // receipt. They remain terminally relevant even though actor execution has
  // ended: feedback on the parent's earlier assistant answer must stay closed
  // until this later reply is committed or explicitly cancelled by Stop.
  /** @type {Map<string, number>} rootSessionId → uncommitted settled replies */
  const pendingReplies = new Map();
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
  // Callers key on the resolved actorSessionId (the canonical serialization
  // target), NOT the display instanceId — a web actor's instanceId is the
  // constant 'web' for every sender-scoped web actor, so keying on it would
  // collapse independent actors under one dedupe entry (#8). This helper just
  // joins its two string args; the first is the actorSessionId at every site.
  /** @param {string} actorSessionId @param {string} message */
  const intentKey = (actorSessionId, message) => `${actorSessionId}\u0000${message}`;
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
  // Feedback and other human-only terminal actions need to distinguish an idle
  // main turn from a chat whose actor work is still outstanding.
  /** @param {string} root @returns {boolean} */
  const hasInFlightFor = (root) =>
    (inFlight.get(root) ?? 0) > 0 || (pendingReplies.get(root) ?? 0) > 0;
  // Stop every actor this lineage has in flight: bump the generation (so QUEUED
  // turns skip) and return the RUNNING ones (so the caller aborts their slots).
  /** @param {string} root @returns {string[]} */
  const stopActorsFor = (root) => {
    stopGen.set(root, (stopGen.get(root) ?? 0) + 1);
    return actorsFor(root);
  };

  // Cancellation scoped to ONE delivery (by correlationId) — what an actor's
  // awaitReply abort uses (#1/#3). why not the root Stop generation: a gen bump
  // is ROOT-wide, so one child's timeout/cancel would gen-skip a SIBLING's
  // distinct queued turn under the same root (and turnSlots.stop unconditionally
  // would abort whatever is running on the shared actor — possibly the sibling's
  // turn). The user's Stop (stopActorsFor) keeps the gen bump because tree-wide
  // IS its semantics; a child's abort must kill only its OWN delegate.
  /** @type {Set<string>} correlationIds whose queued delivery must skip */
  const cancelledDeliveries = new Set();
  /** @type {Map<string, string>} actorSessionId → correlationId of the turn NOW running on it */
  const runningOnActor = new Map();

  // Stop the ONE actor turn an actor's awaitReply was waiting on, when that
  // actor aborts. A still-QUEUED delivery is marked cancelled (it skips when
  // the slot frees); a RUNNING one is slot-aborted ONLY when the running turn is
  // this delivery's own (runningOnActor match) — a sibling's turn on the same
  // shared actor is never collateral. turnSlots.stop is optional (the pure-heap
  // test harness injects no stop; the await resolves either way).
  /** @param {string} correlationId @param {string} actorSessionId @returns {boolean} whether this delivery was already running */
  const stopActorForAwait = (correlationId, actorSessionId) => {
    cancelledDeliveries.add(correlationId);
    const wasRunning = runningOnActor.get(actorSessionId) === correlationId;
    if (wasRunning) {
      /** @type {{ stop?: (id: string) => boolean }} */ (turnSlots).stop?.(actorSessionId);
    }
    return wasRunning;
  };

  /** @param {string} root */
  const decInFlight = (root) => {
    const c = (inFlight.get(root) ?? 1) - 1;
    if (c <= 0) inFlight.delete(root); else inFlight.set(root, c);
  };
  /** @param {string} root */
  const trackPendingReply = (root) => {
    pendingReplies.set(root, (pendingReplies.get(root) ?? 0) + 1);
  };
  /** @param {string} root */
  const clearPendingReply = (root) => {
    const count = (pendingReplies.get(root) ?? 1) - 1;
    if (count <= 0) pendingReplies.delete(root); else pendingReplies.set(root, count);
  };

  // Build the ONE reply text shape (trusted lead + fenced body) both reply
  // modes share: deliver() re-enters a long-lived sender with it; the
  // awaitReply path (an actor's call) resolves it into the tool result.
  /** @param {string} instanceId @param {string} kind @param {string|undefined} name @param {string} body @param {boolean} [failed] @param {boolean} [outcomeUnknown] @param {boolean|undefined} [performed] */
  const replyText = (instanceId, kind, name, body, failed = false, outcomeUnknown = false, performed = undefined) => {
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
    // A keyword-addressed singleton (web, dweb) has instanceId === kind; naming
    // both would double the word ("the dweb actor dweb").
    const subject = (String(kind) === String(instanceId))
      ? `The ${kind} actor`
      : (kind === 'web' && /^https?:\/\//.test(String(instanceId)))
        ? `The ${instanceId} integration`
        : `The ${kind} actor ${safeName ? `${safeName} (${instanceId})` : instanceId}`;
    const lead = outcomeUnknown
      ? `${subject} did not complete cleanly. Its outcome is unknown. Do not retry automatically:`
      : performed === false
        ? `${subject} did not run the request:`
        : failed
        ? `${subject} could not complete your request:`
        : `${subject} you messaged has replied:`;
    return `${lead}\n\n${wrapped}`;
  };

  // Build the one envelope used by live delivery and passive restart recovery.
  // Only the locally composed lead is trusted. The body remains fenced even for
  // fixed recovery copy, so the model-facing shape never depends on its source.
  /** @param {string} instanceId @param {string} kind @param {string|undefined} name @param {string} body @param {boolean} failed @param {string|undefined} via @param {boolean} outcomeUnknown @param {boolean|undefined} performed @param {string|undefined} actorDeliveryId @param {string|undefined} parentToolUseId @param {boolean} [aborted] */
  const deliveryEnvelope = (instanceId, kind, name, body, failed, via, outcomeUnknown, performed, actorDeliveryId = undefined, parentToolUseId = undefined, aborted = false) => {
    const userText = replyText(instanceId, kind, name, body, failed, outcomeUnknown, performed);
    const safeName = name ? escapeAttr(name.replace(/\s+/g, ' ').trim().slice(0, 80)) : undefined;
    const safeParentToolUseId = typeof parentToolUseId === 'string' && parentToolUseId.length <= 512
      ? parentToolUseId
      : undefined;
    return {
      userText,
      actorReply: {
        kind, instanceId, ...(safeName ? { name: safeName } : {}), failed,
        ...(outcomeUnknown ? { outcomeKnown: false } : performed === false ? { outcomeKnown: true } : {}),
        ...(performed !== undefined ? { performed } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(via ? { via } : {}),
        ...(actorDeliveryId ? { actorDeliveryId } : {}),
        ...(safeParentToolUseId ? { parentToolUseId: safeParentToolUseId } : {}),
      },
    };
  };

  // Re-enter the SENDER with the actor's reply as a synthetic, wrapUntrusted-
  // fenced wake, via a claimed idle wake so it NEVER steer-aborts the
  // user's live turn (the focus/work-theft bug, DECISIONS #20). Only the one-line
  // lead is trusted; the actor's body is fenced (mandatory for App actors,
  // which render attacker content).
  /** @param {string} senderSessionId @param {string} instanceId @param {string} kind @param {string|undefined} name @param {string} body @param {boolean} [failed] @param {string} [via] @param {boolean} [outcomeUnknown] @param {boolean} [performed] @param {string} [actorDeliveryId] @param {string} [parentToolUseId] @param {() => boolean} [shouldSkip] @param {() => Promise<unknown>} [onSkip] @param {boolean} [aborted] @returns {Promise<boolean>} */
  const deliver = (senderSessionId, instanceId, kind, name, body, failed = false, via = undefined, outcomeUnknown = false, performed = undefined, actorDeliveryId = undefined, parentToolUseId = undefined, shouldSkip = () => false, onSkip = async () => {}, aborted = false) => {
    // actorReply rides the wake so the UI can render the reply as its OWN
    // attributed chat bubble at the bottom (not buried in the tool-call card).
    // `synthetic` alone can't carry this — it also marks truncation/resume
    // nudges, which must stay hidden. name is sanitized the same way replyText's
    // lead is (it renders un-fenced in the bubble's attribution line). `via`
    // attributes a mediated delegation if a future async code surface routes
    // its reply here; without that, a late bubble would be unexplainable.
    const { userText, actorReply } = deliveryEnvelope(
      instanceId, kind, name, body, failed, via, outcomeUnknown, performed, actorDeliveryId, parentToolUseId, aborted,
    );
    return new Promise((resolve) => {
      try {
        const start = (/** @type {{ controller: AbortController, release: () => void } | undefined} */ turnLease) => {
          // The actor may have settled while its parent was still busy. Stop's
          // generation is rechecked at the exact parent dequeue boundary so an
          // explicit Stop cannot be followed by a fresh synthetic model turn.
          if (shouldSkip()) {
            Promise.resolve(onSkip())
              .then(
                () => resolve(true),
                (e) => { log('stopped reply cleanup failed', e); resolve(false); },
              )
              .finally(() => turnLease?.release());
            return;
          }
          // trusted:true: the reply wake is a first-party continuation. The reply
          // body remains fenced. Resolve false instead of rejecting because most
          // live deliveries are fire-and-forget; recovery callers use the boolean
          // to retain their durable record until the warning lands successfully.
          Promise.resolve(reenter({
            userText, sessionId: senderSessionId, synthetic: true, trusted: true,
            actorReply, ...(turnLease ? { turnLease } : {}),
          }))
            .then(
              () => resolve(true),
              async (e) => {
                log('reenter failed', e);
                // Preserve the already-settled reply without starting another
                // model turn. If this passive write succeeds, acknowledge the
                // mailbox now; otherwise retain it for restart recovery.
                let recorded = false;
                if (actorDeliveryId) {
                  try {
                    recorded = await recordRecovery({
                      userText, actorReply, sessionId: senderSessionId,
                      synthetic: true, recoveryId: actorDeliveryId,
                    });
                  } catch (error) { log('passive reply receipt failed', error); }
                  if (recorded) await mailbox.remove(actorDeliveryId).catch(() => {});
                }
                resolve(recorded);
              },
            )
            // runAgentTurn owns the normal release. This backstop covers a
            // synchronous/early reentry failure before it reaches the driver.
            .finally(() => turnLease?.release());
        };
        if (typeof turnSlots.runWhenIdleClaimed === 'function') {
          turnSlots.runWhenIdleClaimed(senderSessionId, start);
        } else {
          turnSlots.runWhenIdle(senderSessionId, () => start(undefined));
        }
      } catch (e) {
        log('reenter queue failed', e);
        resolve(false);
      }
    });
  };

  // Queue one engine actor turn on its slot and route the fenced reply to the
  // sender. Durable acknowledgement belongs to the session post-commit hook;
  // this module clears only correlations that provably have no persistence path.
  // parentToolUseId keys the actor's display stream.
  //
  // Reply routing: `onReply` (the awaitReply path — an actor's call) receives
  // the composed reply text and its failed flag INSTEAD of the deliver() wake;
  // the caller resolves it into the tool result. Every settle path — success,
  // thrown turn, Stop-skip — routes through exactly one of onReply/deliver, so
  // an awaiting caller is never left hanging.
  //
  // Bookkeeping is keyed by rootSessionId (phase 4/5): the lineage root shares
  // one budget and one Stop generation, whoever in the tree actually sent.
  /** @param {{ correlationId: string, senderSessionId: string, rootSessionId: string, actor: { instanceId: string, kind: string, actorSessionId: string, name?: string, tabId?: number }, message: string, parentToolUseId?: string, oneShot?: boolean, bare?: boolean, via?: string, onReply?: (text: string, failed: boolean, outcomeUnknown: boolean, performed?: boolean, aborted?: boolean) => boolean|void, deliverInstead?: () => boolean }} o */
  const runEngineDelivery = ({ correlationId, senderSessionId, rootSessionId, actor, message, parentToolUseId, oneShot, bare, via, onReply, deliverInstead }) => {
    const { instanceId, kind, actorSessionId, name, tabId } = actor;
    trackActor(rootSessionId, actorSessionId);
    // Keyed on actorSessionId, NOT instanceId — must match the live-path track
    // (a constant 'web' instanceId would alias-collapse sender-scoped web actors;
    // see the dedupe note in messageActor). clearTracking() uses THIS key, so
    // the track/untrack pair stays symmetric across both paths (#4/#8).
    const intentK = intentKey(actorSessionId, message);
    // Capture the root's Stop generation NOW — if the user Stops while this turn is
    // queued behind another on the same actor slot, the generation advances and we
    // skip it when the slot finally frees (so Stop reaches queued work, not just the
    // running slot turnSlots.stop aborts). The bookkeeping is cleared either way.
    const genAtQueue = stopGen.get(rootSessionId) ?? 0;
    const clearTracking = () => {
      decInFlight(rootSessionId);
      untrackActor(rootSessionId, actorSessionId);
      untrackIntent(rootSessionId, intentK);
      // Self-scoped, like a turn-slot release: the next queued turn may have
      // already stamped itself onto the actor before this settle unwinds.
      if (runningOnActor.get(actorSessionId) === correlationId) runningOnActor.delete(actorSessionId);
      // An abort that fired while this turn was RUNNING added the correlation to
      // the cancelled set after the queued-wake check had already passed — drop
      // it on settle so the set never grows past the in-flight deliveries.
      cancelledDeliveries.delete(correlationId);
    };
    const removeMailbox = () => mailbox.remove(correlationId);
    const clearMailbox = () => removeMailbox().catch(() => {});
    // ONE reply seam for both modes (see routing note above). `bare` hands the
    // awaiting caller the RAW reply body instead of the formatted lead+fence:
    // the script surface's asks resolve into CODE, where fence markup is
    // plumbing noise (a reply fed into the next actor's goal would embed it) —
    // the fence is re-applied at the script-RESULT boundary, the one place the
    // bytes meet a model (script.js usedActors fencing). Model-facing resolves
    // (an actor's awaitReply) keep the formatted text.
    // `rawBody` is the actor's UNCLAMPED result (the RESULT_CHARS bound is applied
    // below, per path). why unclamped in: the schema path must see the FULL JSON —
    // clamping first could truncate a valid envelope mid-string, corrupting it into
    // a false "did not match format" reject. The schema's own field caps
    // (reply-schema.js) are the size bound for the validated path; the free-form
    // and error paths keep the RESULT_CHARS clamp on the way out.
    /** @param {string} rawBody @param {boolean} failed @param {boolean} [outcomeUnknown] @param {boolean} [performed] @param {boolean} [aborted] */
    const settle = (rawBody, failed, outcomeUnknown = false, performed = true, aborted = false) => {
      let outBody = rawBody;
      let outFailed = failed;
      // #241 — the deterministic schema boundary. An untrusted actor (web/api)
      // must return a strict JSON envelope; validate it HERE, before it crosses
      // to the orchestrator, and hand up only the fields WE re-render. why not on
      // `failed`: that body is a runtime error notice WE composed, not actor
      // output. why not `bare`: the script/a2a surface resolves raw bytes into
      // CODE (re-fenced at the script boundary), a different contract. A
      // non-conforming reply is dropped for a fixed, content-free notice — the
      // rejected bytes never reach the orchestrator as free text.
      if (schemaValidatedReplies() && !failed && !bare && SCHEMA_VALIDATED_KINDS.has(kind)) {
        const v = validateActorReply(rawBody);
        if (v.ok) { outBody = renderValidatedReply(v.value); outFailed = v.value.status === 'failed'; }
        else {
          outBody = REPLY_VALIDATION_FAILED;
          outFailed = true;
          // reason is a fixed, content-free string (reply-schema.js) — safe to audit.
          appendAudit({ type: 'actor_reply_rejected', details: { instanceId, kind, reason: v.reason } }).catch(() => {});
        }
      }
      // Bound the OUTPUT: the validated body is already field-cap-bounded, the
      // free-form/error bodies were previously clamped at the callsite — apply the
      // single RESULT_CHARS ceiling here for every path.
      outBody = outBody.slice(0, RESULT_CHARS);
      // deliverInstead() true = the awaiting caller already resolved by its
      // wall-clock cap (degrade-to-async): the actor kept working, so its now-
      // arrived reply must route to the sender's LATER turn (deliver) instead of
      // an onReply the caller has stopped listening on — otherwise the reply is
      // dropped. Only the orchestrator opt-in await sets this (it has a later
      // turn); an ephemeral child never does (no later turn to wake).
      //
      // Ordering note (rebase onto #255): validation + the RESULT_CHARS clamp run
      // FIRST, so a degraded reply that lands on the later turn is the same
      // validated, bounded body the awaiting caller would have received.
      if (onReply && !(deliverInstead && deliverInstead())) {
        const accepted = onReply(
          bare ? outBody : replyText(instanceId, kind, name, outBody, outFailed, outcomeUnknown),
          outFailed,
          outcomeUnknown,
          performed,
          aborted,
        );
        // An accepted awaited reply is not delivered until its parent tool
        // result is committed to session history. Keep the mailbox row until
        // that post-commit acknowledgement. If the caller has already stopped
        // listening, this settled result has no persistence path, so close the
        // correlation here instead of leaking it forever.
        if (accepted !== true) clearMailbox();
        return;
      }
      // Reentry success is not durability. The synthetic actorReply carries the
      // correlation id into the appended user message; the session post-commit
      // hook owns mailbox removal. A busy or failed parent keeps the row for
      // passive recovery, and even a fulfilled turn cannot clear it early.
      trackPendingReply(rootSessionId);
      void deliver(
        senderSessionId, instanceId, kind, name, outBody, outFailed, via,
        outcomeUnknown, performed, correlationId, parentToolUseId,
        () => (stopGen.get(rootSessionId) ?? 0) !== genAtQueue,
        removeMailbox,
        aborted,
      ).then((committedOrCancelled) => {
        if (committedOrCancelled) clearPendingReply(rootSessionId);
      });
    };
    // Serialize on the ACTOR's slot — runWhenIdle runs the turn the moment the
    // actor is idle (never interrupting an in-flight actor turn). A thrown/
    // failed actor turn STILL wakes the sender (with an error notice) so the
    // caller is never left hanging.
    /** @param {(lease: { controller: AbortController, release: () => void } | undefined) => void|Promise<void>} fn */
    const runClaimed = (fn) => {
      if (typeof turnSlots.runWhenIdleClaimed === 'function') {
        turnSlots.runWhenIdleClaimed(actorSessionId, fn);
      } else {
        turnSlots.runWhenIdle(actorSessionId, () => fn(undefined));
      }
    };
    runClaimed(async (turnLease) => {
      // Address resolution happened before this delivery entered the actor's
      // serialized slot. Revalidate now so an origin stop that retired this
      // session while we waited cannot carry its page-influenced transcript into
      // another turn. A false/failed check is a definite Not run result.
      let current = false;
      try { current = await isActorSessionCurrent(actorSessionId) === true; }
      catch { current = false; }
      if (!current) {
        settle('the actor request was not run because that helper was retired.', true, false, false);
        clearTracking();
        if (turnLease) turnLease.release();
        else turnSlots.advanceQueue?.(actorSessionId);
        return;
      }
      // Stopped after we queued → don't start the turn. Two cancel signals land
      // here: the user's tree-wide Stop (the root's generation advanced) and the
      // awaiting actor's own abort (THIS delivery marked cancelled — never a
      // sibling's). A woken sender would re-start unwanted post-Stop activity,
      // so the wake path stays silent — but an AWAITING caller (onReply) must
      // still resolve, or its tool call would hang past the Stop/abort that was
      // meant to end it.
      if ((stopGen.get(rootSessionId) ?? 0) !== genAtQueue || cancelledDeliveries.has(correlationId)) {
        if (onReply) {
          onReply(
            bare ? 'the request was stopped before the actor ran it.' : replyText(instanceId, kind, name, 'the request was stopped before the actor ran it.', true),
            true,
            false,
            false,
            true,
          );
        }
        clearTracking();
        clearMailbox();
        if (turnLease) turnLease.release();
        // We were handed the idle actor slot but are DECLINING to run a turn
        // (Stopped after we queued). No claim/release will happen, so nothing
        // would re-drain the actor's queue — every turn queued behind us would
        // strand until the next unrelated message to this actor. Hand the slot
        // to the next queued wake so post-Stop skips cascade to completion.
        if (!turnLease) turnSlots.advanceQueue?.(actorSessionId);
        return;
      }
      // Instrumentation (temporary): the actor turn's wall-clock. It spans the
      // tool work (e.g. a VM command — logged separately as [vm.timing]) PLUS the
      // model inference to compose the reply. (actorTurnMs − the tool's own ms) is
      // that reply inference — the extra turn a delegation spends to summarize one
      // result, which (with the orchestrator's own turn) is the two-inference cost
      // a simple "run X and report" pays over running it inline.
      const turnStartedAt = now();
      // Stamp WHOSE delivery now runs on this actor, so an awaitReply abort can
      // tell "my own turn is running (stop the slot)" from "a sibling's is
      // (leave it alone)". Cleared self-scoped in clearTracking().
      runningOnActor.set(actorSessionId, correlationId);
      Promise.resolve(runActorTurn({
        actorSessionId, message, actorTabId: tabId, instanceId, kind,
        correlationId, parentToolUseId, parentSessionId: senderSessionId, rootSessionId,
        name, oneShot,
        ...(turnLease ? { turnLease } : {}),
      }))
        .then((res) => {
          log('actor.timing', { kind, instanceId, actorTurnMs: now() - turnStartedAt });
          const isolationFailure = res?.isolationFailure;
          const performed = typeof res?.performed === 'boolean'
            ? res.performed
            : typeof isolationFailure?.performed === 'boolean'
              ? isolationFailure.performed
              : true;
          const outcomeKnown = typeof res?.outcomeKnown === 'boolean'
            ? res.outcomeKnown
            : typeof isolationFailure?.outcomeKnown === 'boolean'
              ? isolationFailure.outcomeKnown
              : undefined;
          const aborted = res?.aborted === true || isolationFailure?.aborted === true;
          const outcomeUnknown = outcomeKnown === false
            || (res?.executionFailed === true && outcomeKnown !== true)
            // A Stop after the actor began cannot prove that its earlier tools
            // or external effects did not land. Only explicit positive host
            // evidence may turn this into a clean cancellation.
            || (aborted && performed !== false && outcomeKnown !== true);
          // Unclamped in — settle applies the RESULT_CHARS ceiling per path, AFTER
          // schema validation (#241) so a valid envelope isn't truncated mid-JSON.
          return settle(
            res?.result || '(the actor produced no text reply)',
            res?.stopped === true,
            outcomeUnknown,
            performed,
            aborted,
          );
        })
        .catch((e) => settle(
          `the actor turn failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`,
          true,
          true,
        ))
        .finally(() => {
          // The driver normally releases this lease. This idempotent backstop
          // covers setup failures before it reaches the driver.
          if (turnLease) turnLease.release();
          clearTracking();
        });
    });
  };

  /**
   * @param {{ to?: string, message?: string, senderSessionId?: string|null, inbound?: boolean, toolUseId?: string, oneShot?: boolean, awaitReply?: boolean, awaitCapMs?: number, degradeToAsync?: boolean, via?: string, bareReply?: boolean, awaitSignal?: { aborted: boolean, reason?: unknown, addEventListener: (t: string, fn: () => void, opts?: object) => void, removeEventListener?: (t: string, fn: () => void) => void } }} req
   *   awaitReply — the ACTOR reply mode (PR #134): resolve the fenced reply
   *   into this call's result instead of a later-turn wake. Set by the
   *   message_actor tool for a `kind:'spawned'` sender.
   *   degradeToAsync + awaitCapMs — the orchestrator opt-in await's wall-clock
   *   cap. When degradeToAsync is true and the cap elapses before the reply, the
   *   await resolves with a non-failed "still working" note WITHOUT cancelling the
   *   actor, and the eventual reply routes to the sender's later turn (deliver).
   *   Only a long-lived sender (has a later turn) sets these; an ephemeral child
   *   never does (its awaitSignal is its own wall-clock, and it has no later turn).
   *   awaitSignal — the awaiting actor's AbortSignal (its wall-clock timeout
   *   / cancel). Only meaningful with awaitReply: the await races the reply
   *   against it so an aborted child unblocks instead of parking on a hung actor.
   * @returns {Promise<{ ok: boolean, content?: string, error?: string, code?: string, performed?: boolean, outcomeKnown?: boolean, targetRead?: boolean, targetChanged?: boolean, retryable?: boolean, actorDeliveryId?: string, actorCorrelationId?: string, actorTerminal?: boolean, actorOutcomeKnown?: boolean, actorPerformed?: boolean, actorAborted?: boolean }>}
   */
  const messageActor = async (req) => {
    const { to, message, senderSessionId, inbound, toolUseId, oneShot, awaitReply, awaitSignal, awaitCapMs, degradeToAsync, via, bareReply } = req;
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
    if (ASYNC_ACTOR_ACTORS && senderSessionId && senderSessionId !== active) {
      try { ancestry = await getAncestry(senderSessionId); }
      catch (e) { log('getAncestry failed (fail-closed)', e); ancestry = []; }
    }
    const senderAllowed = ASYNC_ACTOR_ACTORS
      ? mayMessageActor({ inbound: inbound === true, senderSessionId, activeSessionId: active, ancestry })
      : (inbound !== true && !!senderSessionId && senderSessionId === active);
    if (!senderAllowed) {
      log('REFUSED', { reason: 'sender_gate', senderSessionId, inbound });
      return { ok: false, error: 'message_actor: only the active foreground chat, its first-party autonomous continuation (a goal turn, or reacting to an actor reply), or a trusted-lineage actor it spawned may message an actor; untrusted/background senders are blocked' };
    }

    // Preserve sender-gate priority, then refuse before target resolution,
    // rate accounting, mailbox persistence, tab creation, or any actor work.
    const isolation = getActorIsolation();
    if (isolation && !actorIsolationAvailable(isolation)) {
      const refusal = actorIsolationRefusal(isolation);
      appendAudit({
        type: 'actor_isolation_refused',
        details: { status: isolation.status, host: isolation.host, code: refusal.code, performed: false },
      }).catch(() => {});
      return refusal;
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
    if (actor && 'resolutionRefusal' in actor) return actor.resolutionRefusal;
    if (!actor) {
      return { ok: false, error: `message_actor: no tab-hosted instance found for id '${to}' (use the create/list tools to find one)` };
    }
    const { instanceId, kind, name, actorSessionId } = actor;

    // oneShot is SANDBOX-ONLY (owner call 2026-07-05): it hands the actor's RAW
    // result straight back, skipping the summarize turn — and that turn is what
    // incidentally COMPRESSES untrusted content. A web/API/dweb reply is
    // page/peer-derived bytes, so it must always ride the summarized (fenced)
    // reply; only an engine sandbox (webvm/notebook/app — the agent's own
    // instance) may hand results back raw. Refuse loudly, never silently strip:
    // a dropped flag would make the model believe the cheap mode worked.
    if (oneShot === true && !ONESHOT_KINDS.has(String(kind))) {
      return { ok: false, error: `message_actor: oneShot is sandbox-only (webvm/notebook/pod/app): a ${kind} actor's reply is untrusted web/peer content and always returns summarized. Re-send without oneShot.` };
    }

    // Phase 7 — mechanical dedupe. An IDENTICAL (actor, message) intent already
    // in flight for this lineage is a double-fire (a parent and its child both
    // asking, or a loop re-asking): refuse loudly, point at the in-flight twin.
    // why keyed on the resolved actorSessionId, not the instanceId: the web
    // actor's instanceId is the CONSTANT literal 'web' for EVERY sender's own
    // private, sender-scoped web actor (resolveWebActor keys by ownerChatId =
    // senderSessionId). Keying on 'web' would alias-collapse two sibling
    // spawned' INDEPENDENT web actors into one dedupe entry under the shared
    // root — wrongly refusing the second, which has no channel to observe the
    // first's reply (#8). actorSessionId is the canonical serialization target:
    // the SAME for two aliases of one actor ('web' vs its tabId both resolve to
    // it — still deduped), DISTINCT for two different actors (admitted).
    const intentK = intentKey(actorSessionId, message);
    if ((inFlightIntents.get(rootSessionId)?.get(intentK) ?? 0) > 0) {
      log('REFUSED', { reason: 'duplicate_intent', senderSessionId, rootSessionId, to: instanceId });
      // why this wording: the in-flight twin may have been sent by a DIFFERENT
      // session in this delegation tree (a sibling actor, or the parent),
      // and its reply routes to THAT sender — never to this one. Telling this
      // caller to "await its reply" would be unactionable (an actor has no
      // channel to observe another's reply). So the honest guidance is: this
      // work is already happening elsewhere in the tree — don't re-send; report
      // that and proceed / synthesize from what you have.
      return { ok: false, error: `message_actor: an identical request to '${to}' is already in flight elsewhere in this chat's delegation tree — do NOT re-send. That work is already happening; proceed with what you have or report that it's underway.` };
    }

    recent.push(nowMs);
    recentSends.set(rootSessionId, recent);
    inFlight.set(rootSessionId, (inFlight.get(rootSessionId) ?? 0) + 1);
    trackIntent(rootSessionId, intentK);
    appendAudit({ type: 'actor_message', details: { to: instanceId, kind, senderSessionId, rootSessionId, lineagePath: provenance.lineagePath, ...(typeof via === 'string' ? { via } : {}) } }).catch(() => {});

    // ASYNC for EVERY long-lived sender, including web, unless the caller opted
    // into `await:true`, which takes the awaitReply branch below instead. On THIS
    // path the orchestrator does not block: it hands a task
    // to the actor and gets woken with the reply on a
    // later turn (the actor model, uniformly). Persist the correlation to the
    // durable mailbox FIRST (await the write so the record is on disk before any
    // requested actor work begins, closing the accept→persist window an SW death
    // could otherwise drop), then queue the wake. Target resolution happened above
    // and may itself have read or minted the actor binding, so a persistence failure
    // reports that honestly even though it never queues the requested turn. The
    // actor's slot serializes its
    // turns (one actor per tab/instance), and deliver() wrapUntrusted-fences the
    // reply, so a web actor's page-derived reply is fenced like any other
    // untrusted content. A storage failure refuses instead of running heap-only.
    // Keep the durable key opaque and bounded. Actor addresses include API
    // origins and may legitimately be much longer than the post-commit hook's
    // defensive id ceiling; embedding the address would make those replies
    // impossible to acknowledge. The mailbox record already stores `to`.
    const correlationId = makeCorrelationId();
    // Persist oneShot for diagnostics. The provenance rides the envelope so boot
    // recovery can reroute a notice whose awaiting sender was ephemeral.
    try {
      await Promise.resolve(mailbox.append({
        id: correlationId, senderSessionId: sender, to: instanceId, message, createdAt: nowMs,
        state: 'queued', kind, ...(name ? { name } : {}),
        ...(typeof toolUseId === 'string' && toolUseId.length <= 512
          ? { parentToolUseId: toolUseId }
          : {}),
        provenance: { rootSessionId, lineagePath: provenance.lineagePath },
        ...(oneShot === true ? { oneShot: true } : {}),
      }));
    } catch (error) {
      decInFlight(rootSessionId);
      untrackIntent(rootSessionId, intentK);
      appendAudit({ type: 'actor_message_persist_failed', details: { to: instanceId, kind } }).catch(() => {});
      return {
        ok: false,
        code: 'actor_mailbox_unavailable',
        error: `message_actor: the actor turn was not queued because the durable mailbox could not record the request; target resolution may already have read or created its actor binding: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`,
        performed: false,
        targetRead: true,
        targetChanged: true,
        retryable: true,
      };
    }

    // Commit the no-replay boundary before the delivery can enter the actor's
    // slot. If this heap disappears after this write, boot recovery reports an
    // unknown outcome instead of repeating a request that may have used tools.
    // The small append-to-started window remains safely replayable because no
    // actor work is queued until both writes finish.
    try {
      await Promise.resolve(mailbox.markStarted(correlationId));
    } catch (error) {
      decInFlight(rootSessionId);
      untrackIntent(rootSessionId, intentK);
      await mailbox.remove(correlationId).catch(() => {});
      appendAudit({ type: 'actor_message_start_persist_failed', details: { to: instanceId, kind } }).catch(() => {});
      return {
        ok: false,
        code: 'actor_mailbox_unavailable',
        error: `message_actor: the actor turn was not run because its durable start state could not be saved: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`,
        performed: false,
        targetRead: true,
        targetChanged: true,
        retryable: true,
      };
    }

    // PR #134 — the ACTOR reply mode. An ephemeral child has no later turn
    // to wake (and waking its session would re-run it on the wrong exposure
    // surface — see the module header), so its reply resolves INTO this call.
    // The actor turn still queues/serializes on the actor's own slot exactly
    // like the async path; only the completion routing differs.
    if (awaitReply === true) {
      const settled = await new Promise((resolve) => {
        // Race the actor reply against the CALLING ACTOR's abort signal.
        // why: the actor is suspended here in tool dispatch, and its loop
        // only observes the signal at wave boundaries — so its wall-clock
        // timeout / actor_cancel (which fire this signal) cannot unwind this
        // await on their own. Without the race, a hung/queued actor turn parks
        // the child, its slot, and its parent's await indefinitely — the exact
        // "parked forever" failure the timeout exists to prevent. On abort we
        // ALSO cancel the actor turn this child was waiting on (stopActorForAwait):
        // it is the child's delegate, so it should die with the child — scoped by
        // CORRELATION, so a sibling's distinct queued/running turn on the same
        // shared actor is never collateral. onReply and onAbort race; the FIRST
        // wins and the loser is a TRUE no-op. why the `done` guard is load-bearing
        // beyond the resolve: the abort listener sits on the child's LONG-LIVED
        // signal, so its OWN wall-clock timeout / cancel can fire onAbort LATE —
        // after a reply already settled. Ungated, that stale abort would mark a
        // settled correlation cancelled (a set entry nothing would ever clean).
        // Gated, the stale abort returns at once. We also detach the listener on
        // settle so an actor making many awaitReply calls doesn't pile no-op
        // listeners on one signal. runEngineDelivery is ALWAYS called so its
        // trackActor/clear bookkeeping stays symmetric even on abort (its onReply
        // just no-ops by then).
        let done = false;
        // Set true when the wall-clock cap fires: the awaited turn keeps running
        // (NOT cancelled), so its later reply must route to the sender's next turn
        // via deliver() — settle() reads this getter. Only the orchestrator opt-in
        // arms the cap (degradeToAsync), and only it HAS a later turn to wake.
        let degraded = false;
        let capTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
        const onAbort = () => {
          if (done) return;                                 // stale abort after the reply → no-op
          // A STEER is not a cancel. The turn slot aborts on Stop AND on a steer
          // (a second message into the same chat supersedes the streaming turn),
          // and both arrive on this one signal. Stop means "end the delegated
          // work" — #134's semantics, kept. A steer means the user ADDED a
          // message; they did not ask for the web actor mid-fetch to be thrown
          // away, and before await:true existed that reply survived a steer and
          // landed on a later turn. So a steer takes the SAME exit as the
          // wall-clock cap: don't stop the actor, mark the correlation degraded,
          // and let the reply wake the sender's next turn — which, on a steer,
          // is the very turn the user just started. Only for a sender that HAS
          // a later turn (degradeToAsync, i.e. the orchestrator opt-in); an
          // ephemeral child has none, so degrading it would drop the reply and
          // it keeps the cancel.
          if (degradeToAsync === true && abortReasonOf(awaitSignal) === ABORT_STEER) { onCap(); return; }
          const wasRunning = stopActorForAwait(correlationId, actor.actorSessionId);
          const notice = 'the request was aborted (timeout or cancel) before the actor replied.';
          finish({
            text: bareReply === true ? notice : replyText(instanceId, kind, name, notice, true),
            failed: true,
            outcomeUnknown: wasRunning,
            performed: wasRunning,
            actorAborted: true,
          });
        };
        // The await wall-clock cap → DEGRADE TO ASYNC. why distinct from onAbort:
        // Stop/cancel means "stop the work"; a too-slow reply does NOT — the actor
        // is still making progress, so we DON'T stopActorForAwait. We unblock the
        // orchestrator turn NOW with a truthful, non-failed note, flip `degraded`
        // so the eventual reply lands as the sender's later-turn wake (deliver),
        // and let the actor finish. This is the bound the orchestrator's turn
        // signal lacks (no wall-clock — only Stop), the "parked forever" case the
        // reviewer flagged; the reply is re-routed, never dropped.
        const onCap = () => {
          if (done) return;
          degraded = true;
          const notice = `the ${kind} actor is still working; its reply will arrive as a fenced note on a later turn.`;
          finish({
            text: bareReply === true ? notice : replyText(instanceId, kind, name, notice, false),
            failed: false, outcomeUnknown: false, actorTerminal: false,
          });
        };
        const finish = (/** @type {{ text: string, failed: boolean, outcomeUnknown: boolean, performed?: boolean, actorTerminal?: boolean, actorDeliveryId?: string, actorAborted?: boolean }} */ v) => {
          if (done) return false;
          done = true;
          if (capTimer) { clearTimeout(capTimer); capTimer = null; }
          try { awaitSignal?.removeEventListener?.('abort', onAbort); } catch { /* stub signal in tests */ }
          resolve(v);
          return true;
        };
        // Queue the actor turn FIRST — so the delivery's bookkeeping (trackActor,
        // and the runningOnActor stamp if the idle slot runs it synchronously)
        // exists before onAbort consults it: an already-aborted signal then either
        // marks the still-queued delivery cancelled or stops its own running turn.
        runEngineDelivery({
          correlationId, senderSessionId: sender, rootSessionId, actor, message,
          parentToolUseId: toolUseId, oneShot: oneShot === true, bare: bareReply === true,
          onReply: (text, failed, outcomeUnknown, performed, aborted) => finish({
            text, failed, outcomeUnknown, performed, actorTerminal: true,
            actorAborted: aborted === true,
            actorDeliveryId: correlationId,
          }),
          deliverInstead: () => degraded,
        });
        if (awaitSignal) {
          if (awaitSignal.aborted) onAbort();               // already aborted → resolve now
          else awaitSignal.addEventListener('abort', onAbort, { once: true });
        }
        // Arm the cap only for the orchestrator opt-in (degradeToAsync + a positive
        // cap). An ephemeral child passes neither — its awaitSignal IS its wall-clock,
        // and it has no later turn, so degrading it would DROP the reply.
        if (degradeToAsync === true && typeof awaitCapMs === 'number' && awaitCapMs > 0 && !done) {
          capTimer = setTimeout(onCap, awaitCapMs);
        }
      });
      return settled.failed
        ? {
          ok: false,
          error: settled.text,
          actorCorrelationId: correlationId,
          actorTerminal: settled.actorTerminal !== false,
          actorOutcomeKnown: settled.outcomeUnknown !== true,
          ...(typeof settled.performed === 'boolean' ? { actorPerformed: settled.performed } : {}),
          ...(settled.actorAborted === true ? { actorAborted: true } : {}),
          ...(settled.actorDeliveryId ? { actorDeliveryId: settled.actorDeliveryId } : {}),
          ...(settled.outcomeUnknown
            ? { performed: true, outcomeKnown: false, retryable: false }
            : {}),
        }
        : {
          ok: true,
          content: settled.text,
          actorCorrelationId: correlationId,
          actorTerminal: settled.actorTerminal !== false,
          actorOutcomeKnown: true,
          ...(typeof settled.performed === 'boolean' ? { actorPerformed: settled.performed } : {}),
          ...(settled.actorAborted === true ? { actorAborted: true } : {}),
          ...(settled.actorDeliveryId ? { actorDeliveryId: settled.actorDeliveryId } : {}),
        };
    }

    runEngineDelivery({ correlationId, senderSessionId: sender, rootSessionId, actor, message, parentToolUseId: toolUseId, oneShot: oneShot === true, via });

    const recipient = (String(kind) === String(instanceId))
      ? `the ${kind} actor`
      : (kind === 'web' && /^https?:\/\//.test(String(instanceId)))
        ? `the ${instanceId} integration`
        : `the ${kind} actor (${name ?? instanceId})`;
    return {
      ok: true,
      content: `Message delivered to ${recipient}. Its reply will arrive on a LATER turn as a fenced note — do NOT wait or poll; continue or end your turn.`,
      actorCorrelationId: correlationId,
      actorTerminal: false,
    };
  };

  // DURABLE RECOVERY (kept as redrain for API compatibility). Called once on SW
  // boot. It never executes stored actor work. A queued entry proves
  // the actor was not dispatched, so the sender receives a Not run notice. A
  // started or legacy entry cannot prove whether tools ran, so the sender receives
  // Outcome unknown and must inspect the target before retrying. Each record is
  // removed only after a stable-id passive notice is persisted. Recovery never
  // invokes the model, so another background loss cannot retry the requested work.
  /** @returns {Promise<{ redrained: number, retained: number }>} */
  const redrain = async () => {
    let entries;
    try { entries = await mailbox.load(); }
    catch (e) { log('redrain load failed', e); return { redrained: 0, retained: 1 }; }
    if (!Array.isArray(entries) || entries.length === 0) return { redrained: 0, retained: 0 };
    let retained = 0;
    for (const e of entries) {
      if (!e?.id || typeof e.senderSessionId !== 'string' || typeof e.to !== 'string' || typeof e.message !== 'string') {
        if (e?.id) mailbox.remove(e.id).catch(() => {});
        continue;
      }
      // The session append and mailbox acknowledgement are separate durable
      // writes. A crash between them leaves the row even though the reply is
      // already visible. Detect that committed custody marker first so recovery
      // does not add a misleading duplicate warning. A failed read retains the
      // row and the recovery gate, then retries passively.
      let alreadyCommitted = false;
      try {
        alreadyCommitted = await deliveryCommitted({
          sessionId: e.senderSessionId,
          deliveryId: e.id,
        });
      } catch (error) {
        log('delivery commit check failed', error);
        retained += 1;
        continue;
      }
      if (alreadyCommitted) {
        try { await mailbox.remove(e.id); }
        catch (error) {
          log('committed delivery cleanup failed', error);
          retained += 1;
        }
        continue;
      }
      const wakeTarget = (typeof e.provenance?.rootSessionId === 'string'
        && e.provenance.rootSessionId !== e.senderSessionId)
        ? e.provenance.rootSessionId
        : e.senderSessionId;
      if (wakeTarget !== e.senderSessionId) {
        appendAudit({ type: 'actor_reply_rerouted', details: { to: e.to, senderSessionId: e.senderSessionId, rootSessionId: wakeTarget } }).catch(() => {});
      }
      const uncertain = e.state === 'started' || e.state === undefined;
      if (uncertain) {
        const envelope = deliveryEnvelope(
          e.to,
          typeof e.kind === 'string' ? e.kind : 'actor',
          typeof e.name === 'string' ? e.name : undefined,
          'peerd cannot confirm whether the previous request ran before the background host restarted. Check whether the requested action completed before trying again.',
          true,
          undefined,
          true,
          undefined,
          undefined,
          typeof e.parentToolUseId === 'string' ? e.parentToolUseId : undefined,
        );
        let recorded = false;
        try {
          recorded = await recordRecovery({ ...envelope, sessionId: wakeTarget, synthetic: true, recoveryId: e.id });
        } catch (error) { log('recovery notice failed', error); }
        if (recorded) await mailbox.remove(e.id).catch(() => {});
        else retained += 1;
        appendAudit({
          type: 'actor_message_outcome_unknown',
          details: { to: e.to, senderSessionId: e.senderSessionId, outcomeKnown: false },
        }).catch(() => {});
        continue;
      }
      if (e.state !== 'queued') {
        await mailbox.remove(e.id).catch(() => {});
        continue;
      }
      const envelope = deliveryEnvelope(
        e.to,
        typeof e.kind === 'string' ? e.kind : 'actor',
        typeof e.name === 'string' ? e.name : undefined,
        'The background host restarted before this actor request was dispatched. It was not run. Re-issue it if it still matters.',
        true,
        undefined,
        false,
        false,
        undefined,
        typeof e.parentToolUseId === 'string' ? e.parentToolUseId : undefined,
      );
      let recorded = false;
      try {
        recorded = await recordRecovery({ ...envelope, sessionId: wakeTarget, synthetic: true, recoveryId: e.id });
      } catch (error) { log('recovery notice failed', error); }
      if (recorded) await mailbox.remove(e.id).catch(() => {});
      else retained += 1;
      appendAudit({
        type: 'actor_message_not_run',
        details: { to: e.to, senderSessionId: e.senderSessionId, performed: false, outcomeKnown: true },
      }).catch(() => {});
    }
    return { redrained: 0, retained };
  };

  return { messageActor, redrain, actorsFor, hasInFlightFor, stopActorsFor };
};
