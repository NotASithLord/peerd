// @ts-check
// chat-reducer.js — the SW-message → UI-state reducer shared by every live
// surface (the side panel AND the full-page home, DESIGN-12).
//
// PURE: (state, msg) → state. No port, no redraw, no IO. Each surface owns its
// own `currentState`, connects its own port, and calls reduceChat on every
// pushed message; the two SURFACE-SPECIFIC side effects stay out of here:
//   - voice/* events (the voice manager lives only in the side panel)
//   - maybeRestoreVoice on a full 'state' snapshot (side-panel only)
//   - the m.redraw() after a fold
// Keeping the fold pure lets home reuse it verbatim and makes it Bun-testable.
//
// A case returns a NEW state object when it changes anything, or the SAME
// `state` ref when there's nothing to fold (per-session-guarded bail, a live
// complement the state push already carries, or an unhandled/voice type) — so
// a surface can skip its redraw on `next === state`.

/**
 * One transcript message (user or assistant). Loosely typed — the SW owns
 * the authoritative shape; the reducer only patches a few fields.
 * @typedef {Object} ChatMessage
 * @property {string} id
 * @property {string} [role]
 * @property {string} [content]
 * @property {string} [thinking]
 * @property {boolean} [streaming]
 * @property {boolean} [synthetic]
 * @property {{ kind: string, instanceId: string, name?: string, failed?: boolean, outcomeKnown?: boolean, performed?: boolean, aborted?: boolean, actorDeliveryId?: string, parentToolUseId?: string, parentToolUseIds?: string[], correlationComplete?: boolean }} [actorReply]
 * @property {string} [stopReason]
 * @property {string} [error]
 * @property {unknown[]} [toolResults]
 * @property {unknown[]} [toolUses]
 * @property {unknown[]} [attachments]
 */

/**
 * An actor's nested session (its own message array).
 * @typedef {Object} SpawnedSession
 * @property {string} sessionId
 * @property {ChatMessage[]} messages
 * @property {string} [kind]
 * @property {number} [depth]
 * @property {string} [task]
 * @property {string} [parentSessionId]
 * @property {string} [rootSessionId]
 * @property {string[]} [grantedTools]
 * @property {boolean} [running]
 * @property {any} [cost]
 */

/**
 * The current session view-state. The SW's 'state'/'turn/state' pushes carry
 * a wider session object; these are the fields the UI reads.
 * @typedef {Object} SessionState
 * @property {string|null} sessionId
 * @property {ChatMessage[]} messages
 * @property {any} cost
 * @property {string} [title]
 * @property {string} [provider]
 * @property {{ mode?: string, confirmActions?: boolean }} [permission]
 * @property {string} [customSystemPrompt]
 * @property {string} [toolManifest]
 * @property {import('/peerd-runtime/todo/core.js').TodoItem[]} [todos]  the goal run's plan-of-record (TodoCard)
 */

/**
 * User settings projected from the SW. Most fields are optional and only a
 * few are read by the panel; the Record arm carries the rest.
 * @typedef {{
 *   reasoningEnabled?: boolean,
 *   spendLimitUsd?: number,
 *   pricingOverrides?: object,
 *   reasoningEffort?: string,
 *   providerName?: string,
 *   providerModel?: string,
 *   openrouterModels?: string[],
 *   voiceEnabled?: boolean,
 *   voiceOnboardingDismissed?: boolean,
 *   voiceVariant?: string,
 *   voiceEngine?: string,
 * } & Record<string, unknown>} SettingsState
 */

/**
 * The shared UI state folded by reduceChat. Mirrors INITIAL_STATE; fields
 * the SW pushes via the 'state' snapshot are merged in wholesale.
 * @typedef {Object} ChatState
 * @property {boolean} hydrated  true only after the surface receives an authoritative SW snapshot
 * @property {{ initialized: boolean, locked: boolean, unlockedAt: number, prfEnrolled: boolean, hasRecovery: boolean, lockReason?: 'idle'|'manual'|null }} vault
 * @property {SessionState} session
 * @property {{ current: string, hasKey: boolean, model: string, configRevision?: number }} providers
 * @property {{ provider: string, model: string, keyless: boolean, credentialReady: boolean, localReady: boolean, ollamaReady?: boolean, canSend: boolean, reason: string|null }} [composer]
 * @property {{ actorExecution?: { status: string, host: string|null, reason: string|null, retryable: boolean }, moonshineVoiceHost?: { status: string }, documentReader?: { status: string } }} [capabilities]
 * @property {{ id: string, peerName: string, onboardingComplete: boolean }} profile
 * @property {SettingsState} settings
 * @property {any} pendingConfirm
 * @property {{ turn: any, session: any, limitUsd: number, limitReached: boolean }} cost
 * @property {string|null|undefined} lastError
 * @property {boolean} streaming
 * @property {{ attempt: number|null, retryAfterMs: number|null }|null} rateLimit
 * @property {ReadonlyArray<{ id: number, text?: string, action?: any, sessionId?: string | null }>} notices
 * @property {any} agentTab
 * @property {ReadonlyArray<any>} agentTabEvents
 * @property {ReadonlyArray<{ id: string, sessionId: string|null, text: string, at: number }>} confirmEvents
 * @property {{ text: string, nonce: number } | null} [composerPrefill]
 * @property {Readonly<Record<string, { stdout: string, stderr: string }>>} vmStreams
 * @property {{ byToolUse: Record<string, string>, sessions: Record<string, SpawnedSession> }} spawned
 * @property {Readonly<Record<string, { sessionId?: string, kind?: string, instanceId?: string, name?: string, actorCorrelationId?: string, fromIndex?: number, messages?: any[], streaming?: boolean, error?: string|null, aborted?: boolean, outcomeKnown?: boolean, performed?: boolean, cost?: any }>>} actors
 * @property {string|null} actorProjectionEpoch
 * @property {number} actorProjectionRevision
 * @property {Record<string, Array<{ seq: number, method: string, to?: string, goalPreview?: string, phase: string, ms?: number|null, failed?: boolean, cancelled?: boolean }>>} scriptOps  live delegation feed per script toolUseId
 * @property {Readonly<Record<string, unknown>>} asyncTasks
 * @property {Readonly<Record<string, { active: boolean, sessionId: string, iteration: number, maxIterations: number, goal: string, phase: string, summary: string|null }>>} goalRuns
 */

/**
 * A pushed SW message. The discriminant is `type` (plus an optional
 * `channel`); the rest of the fields vary per case, so they're modeled as a
 * permissive record the switch reads the relevant slice of.
 * @typedef {{
 *   type: string,
 *   channel?: string,
 *   sessionId?: string,
 *   messageId?: string,
 *   text?: string,
 *   error?: string,
 *   stopReason?: string,
 *   session?: any,
 *   state?: any,
 *   prompt?: any,
 *   id?: string,
 *   turn?: any,
 *   limitUsd?: number,
 *   attempt?: number,
 *   retryAfterMs?: number,
 *   streaming?: boolean,
 *   parentToolUseId?: string,
 *   depth?: number,
 *   task?: string,
 *   parentSessionId?: string,
 *   tasks?: unknown,
 *   action?: any,
 *   tab?: any,
 *   toolUseId?: string,
 *   chunk?: string,
 *   summary?: any,
 *   [k: string]: unknown,
 * }} ReducerMsg
 */

/** @type {ChatState} */
export const INITIAL_STATE = Object.freeze({
  hydrated: false,
  vault: { initialized: false, locked: true, unlockedAt: 0, prfEnrolled: false, hasRecovery: false },
  session: { sessionId: null, messages: [], cost: null },
  providers: { current: 'anthropic', hasKey: false, model: 'claude-sonnet-4-6' },
  // Default profile: peerName labels assistant transcript rows;
  // onboardingComplete gates the first-run "Hello, I'm peerd" screen.
  // why assume complete here: only a real SW push (which carries the
  // persisted latch) may open the gate — never a first paint, so
  // existing installs can't flash the onboarding screen on load.
  profile: { id: 'default', peerName: 'peerd', onboardingComplete: true },
  settings: { reasoningEnabled: true, spendLimitUsd: 0, pricingOverrides: {} },
  pendingConfirm: null,
  // Cost/usage telemetry (feature 06). `cost.turn` is the live tally for
  // the in-flight turn; `cost.session` is the persisted session lifetime
  // total; `cost.limitReached` flips true when the hard spend cap halts
  // the agent (cleared on the next user send). The meter reads these.
  cost: { turn: null, session: null, limitUsd: 0, limitReached: false },
  // Inline turn-status. `streaming` is whether the CURRENTLY VIEWED
  // chat's turn is in flight — live-toggled by turn/streaming pulses
  // (session-guarded) and re-armed by every state push, which carries
  // the per-session truth (turns keep running in background chats).
  // Live delegation feed for in-flight `script` runs, keyed by the script
  // call's toolUseId: [{ seq, method, to, goalPreview, phase, ms }]. Ephemeral
  // UI sugar — the durable record is the [DELEGATIONS] trace in the tool
  // result — so it is never persisted and resets with the panel.
  scriptOps: {},
  lastError: null,
  streaming: false,
  // Rate-limit retry banner: { attempt, retryAfterMs } while the provider
  // adapter is backing off + retrying; null otherwise.
  rateLimit: null,
  // Transient system notices (e.g. /init progress). Each { id, text };
  // the newest renders as a dismissible banner above the input.
  notices: Object.freeze([]),
  // The tab the agent loop most recently created/interacted with (DESIGN-12) —
  // { tabId, label, windowId } | null. The LIVE pointer; client-side (not in the
  // SW snapshot), updated by 'agent/tab' pushes; cleared when the tab closes.
  agentTab: null,
  // Inline "peerd opened a tab" notices — one per DISTINCT tab the agent opened
  // this session, each anchored to the message that was latest when it opened, so
  // it renders inline in the transcript and fades into the backlog as the chat
  // continues (DECISIONS #26 / the owner's call — replaces the old bright sticky
  // card). Each: { key, sessionId, tabId, windowId, kind, name, label, anchorId }.
  agentTabEvents: Object.freeze([]),
  // Self-settled / other-surface confirm outcomes as quiet transcript rows
  // (§4e) - [{ id, sessionId, text, at }]. Live entries fold in from
  // confirm/resolved outcomes; entries that happened while no surface was open
  // arrive via the snapshot's confirmSettleNotes. Deduped by prompt id.
  confirmEvents: Object.freeze([]),
  // A card action's one-shot composer prefill (§4c) - { text, nonce } | null,
  // surface-local (set by uiActions.prefillComposer, consumed by InputBar).
  composerPrefill: null,
  // Streaming stdout/stderr per in-flight vm_boot, keyed by toolUseId.
  vmStreams: Object.freeze({}),
  // Actor transcripts for inline rendering under actor_create tool
  // cards (docs/ACTORS.md).
  spawned: Object.freeze({ byToolUse: {}, sessions: {} }),
  // DESIGN-17 P1 glass pane: actor DISPLAY cards, keyed by the message_actor
  // tool_use id. Each is self-contained (its own sliced transcript) so a long-lived
  // actor messaged N times shows N distinct exchanges, not its whole history.
  // { sessionId, kind, instanceId, name, fromIndex, messages, streaming, error, cost }.
  actors: Object.freeze({}),
  actorProjectionEpoch: null,
  actorProjectionRevision: 0,
  // In-flight async spawned (DESIGN-11), keyed by PARENT session id.
  asyncTasks: Object.freeze({}),
  // Goal mode (the mode-row Goal toggle) — active runs keyed by sessionId, so
  // a run continuing in a background chat tracks independently of the one in
  // view. goal/state pushes set/clear each entry.
  goalRuns: Object.freeze({}),
});

// One quiet sentence per confirm settle (§4e - the four undrawn states). The
// wording is fixed, not composed: these are the shipped strings the redesign
// specifies, one per way a prompt can end without this surface's click.
/** @param {{ cause?: string, answer?: string, via?: string|null }} outcome
 *  @returns {string|null} */
const confirmSettleText = ({ cause, answer, via }) => {
  if (cause === 'timeout') return 'Not approved - no answer in two minutes.';
  if (cause === 'unreachable') return 'Not approved - peerd wasn’t open to ask.';
  if (cause === 'stop' || cause === 'abort') return 'Not approved - you stopped the turn.';
  if (cause === 'answer') {
    const verdict = answer === 'no' ? 'Not approved'
      : answer === 'yes_session' ? 'Approved for this chat' : 'Approved once';
    return `${verdict}, from the ${via === 'home' ? 'home tab' : 'side panel'}.`;
  }
  return null;
};

// Append one settle line, deduped by prompt id (a live broadcast and a later
// snapshot replay must not double-report the same settle). Kept ordered by
// time - a snapshot can replay an OLD settle after newer live ones, and an
// out-of-order append would render it as the freshest row. The cap is well
// above the SW's per-session note cap so eviction here can't resurrect
// still-snapshotted notes as fresh.
/**
 * @param {ReadonlyArray<{ id: string, sessionId: string|null, text: string, at: number }>} events
 * @param {{ id: string, sessionId: string|null, text: string, at: number }} event
 */
const appendConfirmEvent = (events, event) => (events.some((e) => e.id === event.id)
  ? events
  : [...events, event].sort((a, b) => a.at - b.at).slice(-100));

// The turn a tool_use belongs to: find the assistant message carrying it (by tool_use
// id), then walk back to the nearest non-synthetic, non-toolResult-only user message —
// that turn's starting message id. null if the tool_use isn't in view yet. Used to anchor
// an agent-tab notice to the message_actor turn that drives its actor (DESIGN-18).
/** @param {any[]} messages @param {string} toolUseId @returns {string|null} */
const turnIdForToolUse = (messages, toolUseId) => {
  let i = (messages ?? []).findIndex((/** @type {any} */ m) =>
    Array.isArray(m?.toolUses) && m.toolUses.some((/** @type {any} */ tu) => tu && tu.id === toolUseId));
  if (i < 0) return null;
  for (; i >= 0; i--) {
    const mm = messages[i];
    const toolResultOnly = (!mm.content || mm.content === '')
      && Array.isArray(mm.toolResults) && mm.toolResults.length > 0;
    if (mm.role === 'user' && !mm.synthetic && !toolResultOnly) return mm.id;
  }
  return null;
};

// ---- streaming reducers (patch one message in place) ----------------------

/**
 * @param {ChatState} state
 * @param {{ sessionId?: string, messageId?: string, text?: string }} msg
 * @returns {ChatState}
 */
const applyDelta = (state, { sessionId, messageId, text }) => {
  if (state.session.sessionId && state.session.sessionId !== sessionId) return state;
  const idx = state.session.messages.findIndex((mm) => mm.id === messageId);
  if (idx === -1) return state;
  const before = state.session.messages.slice(0, idx);
  const after = state.session.messages.slice(idx + 1);
  const patched = { ...state.session.messages[idx],
    content: (state.session.messages[idx].content ?? '') + text };
  return { ...state, session: { ...state.session, messages: [...before, patched, ...after] } };
};

// Reasoning (extended-thinking) deltas stream into a separate `thinking`
// field so reasoning and answer text accrue independently in one message.
/**
 * @param {ChatState} state
 * @param {{ sessionId?: string, messageId?: string, text?: string }} msg
 * @returns {ChatState}
 */
const applyReasoning = (state, { sessionId, messageId, text }) => {
  if (state.session.sessionId && state.session.sessionId !== sessionId) return state;
  const idx = state.session.messages.findIndex((mm) => mm.id === messageId);
  if (idx === -1) return state;
  const before = state.session.messages.slice(0, idx);
  const after = state.session.messages.slice(idx + 1);
  const patched = { ...state.session.messages[idx],
    thinking: (state.session.messages[idx].thinking ?? '') + text };
  return { ...state, session: { ...state.session, messages: [...before, patched, ...after] } };
};

/**
 * @param {ChatState} state
 * @param {{ sessionId?: string, messageId?: string, stopReason?: string }} msg
 * @returns {ChatState}
 */
const applyStop = (state, { sessionId, messageId, stopReason }) => {
  if (state.session.sessionId && state.session.sessionId !== sessionId) return state;
  return { ...state, session: { ...state.session,
    messages: state.session.messages.map((mm) =>
      mm.id === messageId ? { ...mm, streaming: false, stopReason } : mm) } };
};

/**
 * @param {ChatState} state
 * @param {{ sessionId?: string, messageId?: string, error?: string }} msg
 * @returns {ChatState}
 */
const applyError = (state, { sessionId, messageId, error }) => {
  // Per-session guard first — a background chat's failure shouldn't banner
  // the chat being viewed (its transcript carries the error).
  if (state.session.sessionId && sessionId && state.session.sessionId !== sessionId) return state;
  if (messageId === undefined) return { ...state, lastError: error };
  return { ...state, lastError: error, session: { ...state.session,
    messages: state.session.messages.map((mm) =>
      mm.id === messageId ? { ...mm, streaming: false, error } : mm) } };
};

// ---- actor nested-transcript reducers ----------------------------------

/**
 * @param {ChatState} state
 * @param {SpawnedSession} session
 * @returns {ChatState}
 */
export const putSpawnedSession = (state, session) => {
  const existing = state.spawned.sessions[session.sessionId];
  return {
    ...state,
    spawned: { ...state.spawned,
      // why merge: a turn/spawned-state snapshot is the durable session shape,
      // but the live projection adds parent/running/grantedTools from the start
      // event. Replacing the record made the Actor Fabric forget its boundary
      // exactly when the first transcript snapshot arrived.
      sessions: { ...state.spawned.sessions,
        [session.sessionId]: { ...(existing ?? {}), ...session } } },
  };
};

/**
 * @param {ChatState} state
 * @param {string} sessionId
 * @param {(mm: ChatMessage) => ChatMessage} mapFn
 * @returns {ChatState}
 */
const patchActorMessages = (state, sessionId, mapFn) => {
  const session = state.spawned.sessions[sessionId];
  if (!session) return state;
  return putSpawnedSession(state, { ...session, messages: session.messages.map(mapFn) });
};

// DESIGN-17 P1 glass pane: merge a patch into an actor card (keyed by the
// message_actor tool_use id). Drops a patch with no key (a boot redrain emits no
// display events, so this is belt-and-braces).
/**
 * @param {ChatState} state
 * @param {string | undefined} parentToolUseId
 * @param {Record<string, unknown>} patch
 * @returns {ChatState}
 */
const putActorCard = (state, parentToolUseId, patch) => {
  if (!parentToolUseId) return state;
  const cur = /** @type {any} */ (state.actors)[parentToolUseId] ?? {};
  return { ...state, actors: { ...state.actors, [parentToolUseId]: { ...cur, ...patch } } };
};

/** @param {any} card @param {any} msg */
const actorEventMatchesCard = (card, msg) => !(
  typeof card?.actorCorrelationId === 'string'
  && typeof msg?.actorCorrelationId === 'string'
  && card.actorCorrelationId !== msg.actorCorrelationId
);

/** @param {ChatState} state @param {any} msg */
const actorEventIsStale = (state, msg) => {
  const incomingEpoch = typeof msg?.actorProjectionEpoch === 'string'
    ? msg.actorProjectionEpoch : null;
  if (state.actorProjectionEpoch && incomingEpoch
      && state.actorProjectionEpoch !== incomingEpoch) return true;
  return Number.isSafeInteger(msg?.actorProjectionRevision)
    && state.actorProjectionEpoch !== null
    && msg.actorProjectionRevision < state.actorProjectionRevision;
};

/** @param {ChatState} state @param {any} msg @returns {ChatState} */
const stampActorProjectionRevision = (state, msg) => {
  const incomingEpoch = typeof msg?.actorProjectionEpoch === 'string'
    ? msg.actorProjectionEpoch : null;
  const revision = msg?.actorProjectionRevision;
  if (incomingEpoch && state.actorProjectionEpoch === null) {
    return {
      ...state,
      actorProjectionEpoch: incomingEpoch,
      actorProjectionRevision: Number.isSafeInteger(revision) ? revision : 0,
    };
  }
  if (incomingEpoch && state.actorProjectionEpoch !== incomingEpoch) return state;
  if (!Number.isSafeInteger(revision) || revision <= state.actorProjectionRevision) return state;
  return { ...state, actorProjectionRevision: revision };
};

/**
 * Reconcile the SW's live-only actor snapshot with durable inline cards already
 * observed in this mounted chat. A missing live row settles an in-flight card;
 * terminal activity/cost remains inspectable in the transcript.
 * @param {Record<string, any>} current
 * @param {Record<string, any>} live
 */
const reconcileActorCards = (current, live) => {
  const settled = Object.fromEntries(Object.entries(current ?? {}).map(([id, card]) => [
    id, card?.streaming === true && !Object.hasOwn(live ?? {}, id)
      ? { ...card, streaming: false }
      : card,
  ]));
  return { ...settled, ...(live ?? {}) };
};

/**
 * Fold durable message_actor terminal evidence back into the live-only card
 * projection so a missed turn/actor-done pulse cannot leave a permanent
 * "working…" card.
 *
 * Correlation is transcript-positional and, where available, pinned by the
 * host-authored actorDeliveryId. A provider may reuse a tool_use id in a later
 * turn, so an old receipt must never settle the newer card with the same id.
 * Synthetic receipts contribute metadata only; their untrusted content stays
 * in the separately rendered, fenced actor-reply bubble.
 * @param {Record<string, any>} actors
 * @param {ChatMessage[]} messages
 */
const reconcileActorTerminals = (actors, messages) => {
  /** @type {Map<string, any[]>} */
  const callsById = new Map();
  /** @type {Map<string, any>} */
  const latestCallById = new Map();
  /** @type {any[]} */
  const calls = [];

  for (let messageIndex = 0; messageIndex < (messages ?? []).length; messageIndex++) {
    const message = messages[messageIndex];
    if (message?.role === 'assistant' && Array.isArray(message.toolUses)) {
      for (const rawToolUse of message.toolUses) {
        const toolUse = /** @type {any} */ (rawToolUse);
        if (toolUse?.name !== 'message_actor' || typeof toolUse.id !== 'string') continue;
        const call = { id: toolUse.id, messageIndex, toolUse, result: null, resultIndex: -1 };
        const occurrences = callsById.get(call.id) ?? [];
        occurrences.push(call);
        callsById.set(call.id, occurrences);
        latestCallById.set(call.id, call);
        calls.push(call);
      }
    }
    if (message?.role === 'user' && Array.isArray(message.toolResults)) {
      for (const rawResult of message.toolResults) {
        const result = /** @type {any} */ (rawResult);
        const call = typeof result?.tool_use_id === 'string'
          ? latestCallById.get(result.tool_use_id) : null;
        if (!call || messageIndex < call.messageIndex) continue;
        call.result = result;
        call.resultIndex = messageIndex;
      }
    }
  }

  // Delivery ids are minted by the host and survive in both the immediate tool
  // result and the later synthetic receipt. Treat a duplicate as ambiguous.
  /** @type {Map<string, any|null>} */
  const callsByDelivery = new Map();
  for (const call of calls) {
    const result = call.result;
    if (!result) continue;
    const deliveryIds = [
      ...(typeof result.actorCorrelationId === 'string' ? [result.actorCorrelationId] : []),
      ...(typeof result.actorDeliveryId === 'string' ? [result.actorDeliveryId] : []),
      ...(Array.isArray(result.actorDeliveryIds)
        ? result.actorDeliveryIds.filter((/** @type {any} */ id) => typeof id === 'string') : []),
    ];
    for (const deliveryId of new Set(deliveryIds)) {
      callsByDelivery.set(deliveryId,
        callsByDelivery.has(deliveryId) ? null : call);
    }
  }

  let next = actors ?? {};
  let changed = false;

  /** @param {any} call @param {{ failed: boolean, outcomeKnown?: boolean, performed?: boolean, aborted?: boolean, actorCorrelationId?: string }} terminal */
  const settle = (call, terminal) => {
    if (!call) return;
    const card = next[call.id];
    if (!card) return;
    const callCorrelationIds = [
      call.result?.actorCorrelationId,
      call.result?.actorDeliveryId,
      ...(Array.isArray(call.result?.actorDeliveryIds) ? call.result.actorDeliveryIds : []),
      terminal.actorCorrelationId,
    ].filter((id) => typeof id === 'string');
    if (typeof card.actorCorrelationId === 'string') {
      if (!callCorrelationIds.includes(card.actorCorrelationId)) return;
    } else {
      // Legacy cards without host correlation can only use the conservative
      // latest-occurrence fallback. A correlated older call may still own the
      // live card when a newer same-id request was refused before actor-start.
      if (latestCallById.get(call.id) !== call) return;
      if (terminal.performed === false) return;
    }
    // Uncertainty outranks a cancellation pulse: Stop can race with a dispatched
    // effect, and showing "cancelled" would hide that the target may have changed.
    const aborted = terminal.aborted === true && terminal.outcomeKnown !== false;
    const failed = terminal.failed === true && !aborted;
    const error = failed
      ? terminal.outcomeKnown === false
        ? 'the actor turn ended with an unknown outcome'
        : terminal.performed === false
          ? 'the actor request was not run'
          : 'the actor turn did not complete'
      : null;
    const patch = {
      ...card,
      streaming: false,
      aborted,
      error,
      outcomeKnown: terminal.outcomeKnown ?? true,
      ...(terminal.performed !== undefined ? { performed: terminal.performed } : {}),
    };
    if (card.streaming === patch.streaming && card.aborted === patch.aborted
        && card.error === patch.error && card.outcomeKnown === patch.outcomeKnown
        && (terminal.performed === undefined || card.performed === patch.performed)) return;
    if (!changed) { next = { ...next }; changed = true; }
    next[call.id] = patch;
  };

  // await:true returns the actor's terminal outcome in the tool result and does
  // not append an actorReply. Read only host-stamped metadata here; content can
  // contain actor/page prose and must not decide execution custody.
  for (const call of calls) {
    if (call.toolUse?.input?.await !== true || !call.result) continue;
    if (call.result.actorTerminal === false) continue;
    const failed = call.result.is_error === true;
    const outcomeKnown = typeof call.result.actorOutcomeKnown === 'boolean'
      ? call.result.actorOutcomeKnown : true;
    const performed = typeof call.result.actorPerformed === 'boolean'
      ? call.result.actorPerformed : undefined;
    settle(call, {
      failed, outcomeKnown, performed,
      aborted: call.result.actorAborted === true,
    });
  }

  for (let messageIndex = 0; messageIndex < (messages ?? []).length; messageIndex++) {
    const message = messages[messageIndex];
    if (message?.role !== 'user' || message.synthetic !== true) continue;
    const reply = message?.actorReply;
    const parentId = reply?.parentToolUseId;
    if (!reply || typeof parentId !== 'string') continue;

    let call = null;
    if (typeof reply.actorDeliveryId === 'string') {
      call = callsByDelivery.get(reply.actorDeliveryId) ?? null;
    }
    // A crash can lose A's immediate acknowledgement before a provider later
    // reuses A's tool-use id for B. The host delivery id on the current card and
    // receipt is still sufficient ownership even though transcript occurrence
    // lookup is ambiguous; choose a preceding call only as the lineage anchor.
    if (!call && typeof reply.actorDeliveryId === 'string'
        && next[parentId]?.actorCorrelationId === reply.actorDeliveryId) {
      const preceding = (callsById.get(parentId) ?? [])
        .filter((candidate) => candidate.messageIndex < messageIndex);
      call = preceding.at(-1) ?? null;
    }
    // Legacy/crash snapshots may lack the immediate result metadata. Bare-id
    // fallback is safe only when this transcript contains exactly one such call.
    if (!call && (callsById.get(parentId)?.length ?? 0) === 1) {
      call = callsById.get(parentId)?.[0] ?? null;
    }
    if (!call || call.id !== parentId || messageIndex <= call.messageIndex) continue;
    settle(call, {
      failed: reply.failed === true,
      ...(typeof reply.actorDeliveryId === 'string'
        ? { actorCorrelationId: reply.actorDeliveryId } : {}),
      ...(reply.outcomeKnown !== undefined ? { outcomeKnown: reply.outcomeKnown } : {}),
      ...(reply.performed !== undefined ? { performed: reply.performed } : {}),
      ...(reply.aborted === true ? { aborted: true } : {}),
    });
  }
  return next;
};

/**
 * Keep completed child transcripts addressable from their actor_create cards
 * while overlaying the SW's live-only topology projection.
 * @param {ChatState['spawned']} current
 * @param {ChatState['spawned']} live
 */
const reconcileSpawned = (current, live) => {
  const liveSessions = live?.sessions ?? {};
  const settled = Object.fromEntries(Object.entries(current?.sessions ?? {}).map(([id, session]) => [
    id, session?.running === true && !Object.hasOwn(liveSessions, id)
      ? { ...session, running: false }
      : session,
  ]));
  return {
    byToolUse: { ...(current?.byToolUse ?? {}), ...(live?.byToolUse ?? {}) },
    sessions: { ...settled, ...liveSessions },
  };
};

/**
 * Fold one SW-pushed message into UI state. Pure; see the module header for
 * the side effects that deliberately stay in each surface.
 * @param {ChatState} state
 * @param {ReducerMsg} msg
 * @returns {ChatState} the new state (or `state` unchanged when nothing folds)
 */
export const reduceChat = (state, msg) => {
  if (!msg || typeof msg.type !== 'string') return state;

  switch (msg.type) {
    case 'goal/state': {
      // Goal mode (loop/goal-runner.js), keyed by sessionId: a 'running' push
      // keeps that chat's Goal bar live with the iteration count; any terminal
      // phase removes the entry (the bar self-hides).
      const sid = /** @type {string} */ (msg.sessionId ?? '');
      if (!sid) return state;
      const next = { ...state.goalRuns };
      if (msg.phase === 'running') {
        next[sid] = {
          active: true,
          sessionId: sid,
          iteration: /** @type {number} */ (msg.iteration ?? 0),
          maxIterations: /** @type {number} */ (msg.maxIterations ?? 0),
          goal: /** @type {string} */ (msg.goal ?? ''),
          phase: 'running',
          summary: /** @type {string|null} */ (msg.summary ?? null),
        };
      } else {
        delete next[sid];
      }
      return { ...state, goalRuns: next };
    }
    case 'turn/spawned-start': {
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      // why these casts: an actor-start message always carries a string
      // sessionId (and parentToolUseId when present) by contract — the
      // permissive ReducerMsg types them optional, so name the invariant.
      const sid = /** @type {string} */ (msg.sessionId);
      return { ...state, spawned: { ...state.spawned,
        byToolUse: msg.parentToolUseId
          ? { ...state.spawned.byToolUse, [msg.parentToolUseId]: sid }
          : state.spawned.byToolUse,
        // Merge the trusted live metadata over any durable shell. Reconnects
        // can hydrate the transcript first; start still owns lineage/grants.
        sessions: { ...state.spawned.sessions,
          [sid]: {
            ...(state.spawned.sessions[sid] ?? {}),
            sessionId: sid, kind: 'spawned', depth: msg.depth,
            task: msg.task, parentSessionId: msg.parentSessionId,
            rootSessionId: typeof msg.rootSessionId === 'string' ? msg.rootSessionId : undefined,
            grantedTools: Array.isArray(msg.grantedTools) ? msg.grantedTools : undefined,
            running: true,
            messages: state.spawned.sessions[sid]?.messages ?? [],
          } } } };
    }
    case 'turn/spawned-state':
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      return putSpawnedSession(state, { ...msg.session, running: true });
    case 'turn/spawned-delta':
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      return patchActorMessages(state, /** @type {string} */ (msg.sessionId), (mm) =>
        mm.id === msg.messageId ? { ...mm, content: (mm.content ?? '') + msg.text } : mm);
    case 'turn/spawned-stop':
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      return patchActorMessages(state, /** @type {string} */ (msg.sessionId), (mm) =>
        mm.id === msg.messageId ? { ...mm, streaming: false, stopReason: msg.stopReason } : mm);
    case 'turn/spawned-error':
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      return patchActorMessages(state, /** @type {string} */ (msg.sessionId), (mm) =>
        mm.id === msg.messageId ? { ...mm, streaming: false, error: msg.error } : mm);
    case 'turn/spawned-done': {
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      const sid = /** @type {string} */ (msg.sessionId);
      const session = state.spawned.sessions[sid];
      return session ? putSpawnedSession(state, { ...session, running: false }) : state;
    }
    case 'turn/spawned-tool-use':
    case 'turn/spawned-tool-result':
      // The turn/spawned-state pushes carry the authoritative message array;
      // these are live complements we don't fold separately.
      return state;
    // DESIGN-17 P1 glass pane — the actor DISPLAY stream (parallel to spawned,
    // keyed by the message_actor tool_use id). Each event carries parentToolUseId
    // Root stamps make the display stream safe even while another chat works in
    // the background. A fresh state snapshot replays cards on switch-back.
    case 'turn/actor-start':
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      if (actorEventIsStale(state, msg)) return state;
      return stampActorProjectionRevision(putActorCard(state, /** @type {string} */ (msg.parentToolUseId), {
        sessionId: msg.sessionId, kind: msg.kind, instanceId: msg.instanceId, name: msg.name,
        actorCorrelationId: msg.actorCorrelationId,
        rootSessionId: msg.rootSessionId, parentSessionId: msg.parentSessionId,
        task: msg.task,
        grantedTools: Array.isArray(msg.grantedTools) ? msg.grantedTools : undefined,
        fromIndex: msg.fromIndex ?? 0, messages: [], streaming: true, error: null,
        aborted: false, outcomeKnown: undefined, performed: undefined, cost: null,
      }), msg);
    case 'turn/actor-state': {
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      if (actorEventIsStale(state, msg)) return state;
      // The full actor-session snapshot; slice to this card's exchange (fromIndex).
      const existing = /** @type {any} */ (state.actors)[/** @type {string} */ (msg.parentToolUseId)];
      // Self-seed when the panel connected mid-turn and missed turn/actor-start
      // (the state push carries fromIndex/kind/… for exactly this); without fromIndex
      // we can't place the slice, so drop.
      const fromIndex = existing?.fromIndex ?? msg.fromIndex;
      if (fromIndex == null) return state;
      if (existing && !actorEventMatchesCard(existing, msg)) return state;
      const messages = Array.isArray(msg.session?.messages) ? msg.session.messages.slice(fromIndex) : (existing?.messages ?? []);
      const seed = existing ? {} : {
        fromIndex, kind: msg.kind, instanceId: msg.instanceId, name: msg.name,
        actorCorrelationId: msg.actorCorrelationId,
        rootSessionId: msg.rootSessionId, parentSessionId: msg.parentSessionId,
        task: msg.task,
        grantedTools: Array.isArray(msg.grantedTools) ? msg.grantedTools : undefined,
        streaming: true, error: null, cost: null,
      };
      return stampActorProjectionRevision(
        putActorCard(state, /** @type {string} */ (msg.parentToolUseId), { ...seed, messages }),
        msg,
      );
    }
    case 'turn/actor-error': {
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      if (actorEventIsStale(state, msg)) return state;
      const card = /** @type {any} */ (state.actors)[/** @type {string} */ (msg.parentToolUseId)];
      if (card && !actorEventMatchesCard(card, msg)) return state;
      return stampActorProjectionRevision(putActorCard(state, /** @type {string} */ (msg.parentToolUseId), {
        error: msg.error,
        streaming: false,
        ...(typeof msg.outcomeKnown === 'boolean' ? { outcomeKnown: msg.outcomeKnown } : {}),
        ...(typeof msg.performed === 'boolean' ? { performed: msg.performed } : {}),
      }), msg);
    }
    case 'turn/actor-done': {
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      if (actorEventIsStale(state, msg)) return state;
      // An ABORT (Stop cascade) → 'cancelled' card; a clean failure with no error
      // already folded → mark failed; else just stop the spinner. Short-circuit when
      // the card is already terminal (turn/actor-error folded first) to avoid churn.
      const card = /** @type {any} */ (state.actors)[/** @type {string} */ (msg.parentToolUseId)];
      if (!card || card.streaming === false) return state;
      if (!actorEventMatchesCard(card, msg)) return state;
      /** @type {Record<string, unknown>} */
      const patch = { streaming: false };
      if (msg.aborted) patch.aborted = true;
      else if (msg.ok === false && !card.error) patch.error = 'the actor turn did not complete';
      return stampActorProjectionRevision(
        putActorCard(state, /** @type {string} */ (msg.parentToolUseId), patch), msg);
    }
    case 'turn/actor-cost': {
      if (msg.rootSessionId && state.session.sessionId
        && msg.rootSessionId !== state.session.sessionId) return state;
      if (actorEventIsStale(state, msg)) return state;
      // Phase K: the actor turn's spend, surfaced on its card (delegated work
      // isn't free — make it visible even though caps stay per-session).
      // why the guard: a cost event must only UPDATE an existing card, never
      // create one. onCost fires on every usage event, so a panel that connects
      // mid-turn can see cost before turn/actor-start; self-seeding a card with
      // {cost} and no `streaming` renders a premature green 'ok' and then blocks
      // turn/actor-state's seed (its `existing ? {} : …` gate) from ever applying
      // streaming/kind/name. Let turn/actor-start|state own creation.
      const id = /** @type {string} */ (msg.parentToolUseId);
      const card = /** @type {any} */ (state.actors)[id];
      if (!card || !actorEventMatchesCard(card, msg)) return state;
      return stampActorProjectionRevision(putActorCard(state, id, { cost: msg.cost }), msg);
    }
    case 'script/op': {
      // Upsert by seq: 'sent' creates the line; 'replied'/'failed'/'handed-off'
      // settle the same line with outcome + timing. Guarded to the viewed
      // session; capped so a marathon chat can't grow the map unbounded.
      if (msg.sessionId && msg.sessionId !== state.session.sessionId) return state;
      const tid = typeof msg.toolUseId === 'string' && msg.toolUseId ? msg.toolUseId : null;
      if (!tid) return state;
      const ops = /** @type {Record<string, any[]>} */ ({ ...state.scriptOps });
      const list = [...(ops[tid] ?? [])];
      const idx = list.findIndex((o) => o.seq === msg.seq);
      const entry = {
        seq: msg.seq, method: msg.method, to: msg.to ?? list[idx]?.to,
        goalPreview: msg.goalPreview ?? list[idx]?.goalPreview,
        phase: msg.phase, ms: msg.ms ?? null,
        cancelled: msg.cancelled === true || msg.phase === 'cancelled',
        failed: msg.phase === 'cancelled' ? false : msg.failed === true || msg.error != null,
      };
      if (idx >= 0) list[idx] = { ...list[idx], ...entry };
      else list.push(entry);
      ops[tid] = list;
      const keys = Object.keys(ops);
      if (keys.length > 20) {
        // Age out a SETTLED run's feed first (never a live one); fall back to
        // the first key. toolUseIds are non-numeric strings, so object key
        // order is insertion order — oldest first.
        const evict = keys.find((k) => k !== tid && (ops[k] ?? []).every((o) => o.phase !== 'sent')) ?? keys.find((k) => k !== tid);
        if (evict) delete ops[evict];
      }
      return { ...state, scriptOps: ops };
    }
    case 'async-tasks/update':
      if (state.session.sessionId
        && msg.parentSessionId !== state.session.sessionId
        && !state.spawned.sessions[/** @type {string} */ (msg.parentSessionId)]) return state;
      return { ...state, asyncTasks: { ...state.asyncTasks,
        [/** @type {string} */ (msg.parentSessionId)]: msg.tasks } };
    case 'state': {
      // Full snapshot. Replace, seeding the cost meter from the persisted
      // session tally + the configured limit. (Voice-restore is the surface's
      // job — see the module header.) why preserve pendingConfirm: confirm
      // state is owned by the confirm/request|resolved channel, NOT the
      // snapshot (it carries null) — folding ...msg.state must never wipe a
      // live prompt a 'state' push races with (DESIGN-12). why rateLimit:null:
      // the snapshot carries no rateLimit field, so without an explicit reset
      // the previous chat's retry banner survives the fold and paints on the
      // switched-to (idle) chat — a stale "⏳ Rate limited" control in the wrong
      // conversation. A switched-to chat is never mid-retry from the previous
      // one; an active retry in THIS chat re-asserts via the next pause/delta.
      // why limitReached + the spend-limit lastError are SESSION-scoped (not
      // per-push): they are a halt state ("raise your limit to continue") that
      // must persist until the user acts. A 'state' push fires on a Plan/Act
      // toggle, /system, settings — not just a session switch — so blanket-
      // clearing them erased the actionable halt guidance while the agent was
      // still halted. Clear only on an ACTUAL session switch; within the same
      // session the next send clears them via turn/streaming.
      const sessionChanged = msg.state?.session?.sessionId !== state.session.sessionId;
      const nextSessionId = msg.state?.session?.sessionId ?? null;
      const stillHalted = !sessionChanged && state.cost.limitReached;
      const keepSpendError = !sessionChanged && state.lastError === 'spend-limit-reached';
      const incomingActorEpoch = typeof msg.state?.actorProjectionEpoch === 'string'
        ? msg.state.actorProjectionEpoch : null;
      const incomingActorRevision = Number.isSafeInteger(msg.state?.actorProjectionRevision)
        ? msg.state.actorProjectionRevision : null;
      const actorEpochMismatch = state.actorProjectionEpoch !== null
        && incomingActorEpoch !== null
        && incomingActorEpoch !== state.actorProjectionEpoch;
      const staleActorSnapshot = actorEpochMismatch
        || (state.actorProjectionEpoch !== null
          && (incomingActorEpoch === null || incomingActorEpoch === state.actorProjectionEpoch)
          && incomingActorRevision !== null
          && incomingActorRevision < state.actorProjectionRevision);
      // why prune on switch: actors/spawned/asyncTasks belong to the orchestrator
      // transcript being navigated away from. The fresh snapshot now replays its
      // live rows; within one chat we reconcile those with terminal inline cards
      // so a routine state push cannot erase activity/cost evidence.
      const snapshotMessages = Array.isArray(msg.state?.session?.messages)
        ? msg.state.session.messages : [];
      const pruneProjections = sessionChanged
        ? {
            actors: reconcileActorTerminals(
              staleActorSnapshot ? INITIAL_STATE.actors : (msg.state?.actors ?? INITIAL_STATE.actors),
              snapshotMessages,
            ),
            spawned: staleActorSnapshot
              ? INITIAL_STATE.spawned : (msg.state?.spawned ?? INITIAL_STATE.spawned),
            asyncTasks: staleActorSnapshot
              ? INITIAL_STATE.asyncTasks : (msg.state?.asyncTasks ?? INITIAL_STATE.asyncTasks),
          }
        : {
            actors: reconcileActorTerminals(
              msg.state?.actors && !staleActorSnapshot
                ? reconcileActorCards(state.actors, msg.state.actors)
                : state.actors,
              snapshotMessages,
            ),
            spawned: msg.state?.spawned && !actorEpochMismatch
              ? reconcileSpawned(state.spawned, msg.state.spawned)
              : state.spawned,
            asyncTasks: msg.state?.asyncTasks && !actorEpochMismatch
              ? msg.state.asyncTasks : state.asyncTasks,
          };
      const notices = sessionChanged
        ? state.notices.filter((notice) => !notice.sessionId || notice.sessionId === nextSessionId)
        : state.notices;
      // Confirm settles that happened while NO surface was open (timeout /
      // stop / closed panel) arrive only here, as snapshot notes - fold them
      // into the transcript lines, deduped against any live broadcasts seen.
      const settleNotes = Array.isArray(msg.state?.confirmSettleNotes) ? msg.state.confirmSettleNotes : [];
      const snapshotSid = msg.state?.session?.sessionId ?? null;
      // Events keep their sessionId and render filtered by it, so a chat
      // switch needs no pruning - the cap bounds growth.
      let confirmEvents = state.confirmEvents;
      for (const note of settleNotes) {
        const text = confirmSettleText(note);
        if (text) confirmEvents = appendConfirmEvent(confirmEvents, { id: note.id, sessionId: snapshotSid, text, at: note.at ?? Date.now() });
      }
      const acceptsActorEpoch = !actorEpochMismatch;
      const actorProjectionEpoch = acceptsActorEpoch
        ? (incomingActorEpoch ?? state.actorProjectionEpoch)
        : state.actorProjectionEpoch;
      const actorProjectionRevision = acceptsActorEpoch && state.actorProjectionEpoch === null
        && incomingActorEpoch !== null
        ? (incomingActorRevision ?? 0)
        : acceptsActorEpoch
          ? Math.max(state.actorProjectionRevision, incomingActorRevision ?? 0)
          : state.actorProjectionRevision;
      return { ...state, ...msg.state, hydrated: true, ...pruneProjections, notices,
        actorProjectionEpoch,
        actorProjectionRevision,
        pendingConfirm: sessionChanged ? (msg.state?.pendingConfirm ?? null) : state.pendingConfirm,
        confirmEvents,
        lastError: keepSpendError ? 'spend-limit-reached' : null, rateLimit: null, cost: { ...state.cost,
        session: msg.state?.session?.cost ?? state.cost.session,
        limitUsd: msg.state?.settings?.spendLimitUsd ?? state.cost.limitUsd,
        limitReached: stillHalted } };
    }
    case 'turn/state':
      // Per-session guard: a turn streaming in a BACKGROUND chat must not snap
      // the view to its transcript. Null current = fresh surface adopting it.
      if (state.session.sessionId && state.session.sessionId !== msg.session.sessionId) return state;
      // why todos here: the goal run's plan-of-record (session.todos) is
      // written mid-turn by the todo_* tools, and the TodoCard reads it off
      // state.session — but this LIVE push carries only sessionId+messages, so
      // without it the card wouldn't tick until the next full 'state' snapshot.
      // undefined on non-goal turns (the card self-hides), so it's harmless.
      return { ...state, actors: reconcileActorTerminals(state.actors, msg.session.messages),
        session: { ...state.session,
        sessionId: msg.session.sessionId, messages: msg.session.messages,
        todos: msg.session.todos }, lastError: null };
    case 'turn/cost':
      if (state.session.sessionId && msg.sessionId && state.session.sessionId !== msg.sessionId) return state;
      return { ...state, cost: { ...state.cost, turn: msg.turn, session: msg.session,
        limitUsd: msg.limitUsd ?? state.cost.limitUsd },
        session: { ...state.session, cost: msg.session } };
    case 'turn/spend-limit-reached':
      if (state.session.sessionId && msg.sessionId && state.session.sessionId !== msg.sessionId) return state;
      return { ...state, cost: { ...state.cost, limitReached: true, limitUsd: msg.limitUsd ?? state.cost.limitUsd },
        lastError: 'spend-limit-reached' };
    case 'turn/delta': {
      const next = applyDelta(state, msg);
      // A token arrived → any retry cleared; drop the rate-limit banner.
      return next.rateLimit ? { ...next, rateLimit: null } : next;
    }
    case 'turn/reasoning':
      return applyReasoning(state, msg);
    case 'turn/rate-limit-pause':
      if (state.session.sessionId && msg.sessionId && state.session.sessionId !== msg.sessionId) return state;
      return { ...state, rateLimit: { attempt: msg.attempt ?? null, retryAfterMs: msg.retryAfterMs ?? null } };
    case 'turn/streaming':
      // Per-session lifecycle pulse — a background turn must not flip the
      // viewed chat's composer/spinner.
      if (state.session.sessionId && msg.sessionId && state.session.sessionId !== msg.sessionId) return state;
      return { ...state, streaming: !!msg.streaming, rateLimit: null,
        cost: msg.streaming ? { ...state.cost, turn: null, limitReached: false } : state.cost };
    case 'turn/tool-use':
    case 'turn/tool-result':
      // Real-time complements; the session message array (turn/state) is the
      // source of truth. No fold.
      return state;
    case 'turn/stop':
      return { ...applyStop(state, msg), rateLimit: null };
    case 'turn/error':
      return { ...applyError(state, msg), rateLimit: null };
    case 'confirm/request':
      // Confirmation is authority, not ambient UI. A background actor keeps
      // running when its owner changes chats, but its prompt belongs only in the
      // root chat that initiated it. A switch-back snapshot resurfaces it.
      if (msg.prompt?.ownerSessionId
        && msg.prompt.ownerSessionId !== state.session.sessionId) return state;
      return { ...state, pendingConfirm: msg.prompt };
    case 'confirm/resolved': {
      // Dismiss the same prompt when displayed (DESIGN-12), and record the
      // outcome line (§4e) whether or not THIS prompt was the one on screen -
      // with many pending prompts a settle for an undisplayed one must still
      // reach the transcript. The one suppression: the surface that ANSWERED
      // (outcome.via === the surface this fold is for) - its own click is its
      // own feedback.
      const outcome = /** @type {{ cause?: string, answer?: string, via?: string|null, sessionId?: string|null } | undefined} */ (msg.outcome);
      const mine = outcome?.cause === 'answer' && outcome?.via != null
        && outcome.via === /** @type {{ confirmSurface?: string }} */ (msg).confirmSurface;
      const text = outcome && !mine ? confirmSettleText(outcome) : null;
      const matches = state.pendingConfirm?.id === msg.id;
      if (!matches && !text) return state;
      return {
        ...state,
        pendingConfirm: matches ? null : state.pendingConfirm,
        confirmEvents: text
          ? appendConfirmEvent(state.confirmEvents, {
              id: /** @type {string} */ (msg.id),
              sessionId: outcome?.sessionId ?? state.session.sessionId,
              text,
              at: Date.now(),
            })
          : state.confirmEvents,
      };
    }
    case 'turn/system-note':
      // Lifecycle recovery notes name their owning session. Keep legacy
      // unscoped UI feedback visible, but never show a scoped note in a
      // different open chat.
      if (msg.sessionId && state.session.sessionId !== msg.sessionId) return state;
      return { ...state, notices: [...state.notices,
        { id: Date.now() + Math.random(), text: msg.text, action: msg.action ?? null,
          sessionId: msg.sessionId ?? null }].slice(-3) };
    case 'agent/tab': {
      // The inline "peerd opened a tab" notice: minted the first time peerd OPENS
      // a tab, then RESURFACED into the current turn whenever the agent acts on it
      // again (so it follows the agent's attention and bubbles to the turn's end).
      // Cleared pointer (tab closed) → keep the notices (transcript history).
      const tab = msg.tab ?? null;
      const sid = state.session.sessionId;
      if (!tab || typeof tab.tabId !== 'number') return { ...state, agentTab: tab };
      // Only a real agent touch (noted) creates/resurfaces — a passive current-flag
      // refresh (you clicking a tab) must never move a notice.
      if (tab.noted !== true) return { ...state, agentTab: tab };
      // Where the notice anchors (it renders at that turn's END, so later messages push
      // it down). Prefer the turn that owns the message_actor tool_use DRIVING this tab
      // (tab.parentToolUseId) — so the card flows to its actor's most-recent MESSAGE turn
      // and resurfaces there when re-messaged. why not the wall-clock-latest user message:
      // actor work is async, so a physical tab touch often fires during a LATER turn than
      // the one that invoked the actor, which clumps every card at the chat's end. Fall
      // back to wall-clock for an orchestrator-opened tab (no parentToolUseId) or before
      // the tool_use is in view.
      const msgs = state.session.messages;
      let turnId = tab.parentToolUseId ? turnIdForToolUse(msgs, tab.parentToolUseId) : null;
      if (turnId == null) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const mm = msgs[i];
          const toolResultOnly = (!mm.content || mm.content === '')
            && Array.isArray(mm.toolResults) && mm.toolResults.length > 0;
          if (mm.role === 'user' && !mm.synthetic && !toolResultOnly) { turnId = mm.id; break; }
        }
      }
      const idx = state.agentTabEvents.findIndex((e) => e.sessionId === sid && e.tabId === tab.tabId);
      if (idx >= 0) {
        // Already announced → resurface into the current turn (no-op if it's
        // already anchored there). The custody state can change independently
        // of the turn anchor, so refresh it even when the notice stays put.
        const protectedTab = tab.protected !== false;
        if (state.agentTabEvents[idx].turnId === turnId
          && state.agentTabEvents[idx].protected === protectedTab) {
          return { ...state, agentTab: tab };
        }
        const events = state.agentTabEvents.map((e, i) => (i === idx
          ? { ...e, turnId, protected: protectedTab }
          : e));
        return { ...state, agentTab: tab, agentTabEvents: events };
      }
      // A NEW tab → mint a notice ONLY if peerd opened it (not when the agent
      // merely acted on a tab the user opened — opened:false).
      if (tab.opened === false) return { ...state, agentTab: tab };
      const ev = {
        key: `${sid ?? 's'}:${tab.tabId}`,
        sessionId: sid, tabId: tab.tabId, windowId: tab.windowId ?? null,
        kind: tab.kind ?? null, name: tab.name ?? null, label: tab.label ?? null,
        protected: tab.protected !== false, turnId,
      };
      return { ...state, agentTab: tab, agentTabEvents: [...state.agentTabEvents, ev].slice(-50) };
    }
    case 'vm/stdout-chunk':
    case 'vm/stderr-chunk': {
      const id = msg.toolUseId;
      if (!id) return state;
      const key = msg.type === 'vm/stdout-chunk' ? 'stdout' : 'stderr';
      const prev = state.vmStreams[id] ?? { stdout: '', stderr: '' };
      return { ...state, vmStreams: { ...state.vmStreams,
        [id]: { ...prev, [key]: (prev[key] ?? '') + (msg.chunk ?? '') } } };
    }
    default:
      // voice/* (surface handles) + unknown types — nothing to fold.
      return state;
  }
};
