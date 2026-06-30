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
 * @property {string} [stopReason]
 * @property {string} [error]
 * @property {unknown[]} [toolResults]
 * @property {unknown[]} [toolUses]
 * @property {unknown[]} [attachments]
 */

/**
 * A subagent's nested session (its own message array).
 * @typedef {Object} SubagentSession
 * @property {string} sessionId
 * @property {ChatMessage[]} messages
 * @property {string} [kind]
 * @property {number} [depth]
 * @property {string} [task]
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
 * @property {{ initialized: boolean, locked: boolean, unlockedAt: number, prfEnrolled: boolean, hasRecovery: boolean }} vault
 * @property {SessionState} session
 * @property {{ current: string, hasKey: boolean, model: string }} providers
 * @property {{ id: string, peerName: string, onboardingComplete: boolean }} profile
 * @property {SettingsState} settings
 * @property {any} pendingConfirm
 * @property {{ turn: any, session: any, limitUsd: number, limitReached: boolean }} cost
 * @property {string|null|undefined} lastError
 * @property {boolean} streaming
 * @property {{ attempt: number|null, retryAfterMs: number|null }|null} rateLimit
 * @property {ReadonlyArray<{ id: number, text?: string, action?: any }>} notices
 * @property {any} agentTab
 * @property {ReadonlyArray<any>} agentTabEvents
 * @property {Readonly<Record<string, { stdout: string, stderr: string }>>} vmStreams
 * @property {{ byToolUse: Record<string, string>, sessions: Record<string, SubagentSession> }} subagents
 * @property {Readonly<Record<string, { sessionId?: string, kind?: string, instanceId?: string, name?: string, fromIndex?: number, messages?: any[], streaming?: boolean, error?: string|null, aborted?: boolean, cost?: any }>>} actors
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
  // Streaming stdout/stderr per in-flight vm_boot, keyed by toolUseId.
  vmStreams: Object.freeze({}),
  // Subagent transcripts for inline rendering under spawn_subagent tool
  // cards (docs/SUBAGENTS.md).
  subagents: Object.freeze({ byToolUse: {}, sessions: {} }),
  // DESIGN-17 P1 glass pane: actor DISPLAY cards, keyed by the message_actor
  // tool_use id. Each is self-contained (its own sliced transcript) so a long-lived
  // actor messaged N times shows N distinct exchanges, not its whole history.
  // { sessionId, kind, instanceId, name, fromIndex, messages, streaming, error, cost }.
  actors: Object.freeze({}),
  // In-flight async subagents (DESIGN-11), keyed by PARENT session id.
  asyncTasks: Object.freeze({}),
  // Goal mode (the mode-row Goal toggle) — active runs keyed by sessionId, so
  // a run continuing in a background chat tracks independently of the one in
  // view. goal/state pushes set/clear each entry.
  goalRuns: Object.freeze({}),
});

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

// ---- subagent nested-transcript reducers ----------------------------------

/**
 * @param {ChatState} state
 * @param {SubagentSession} session
 * @returns {ChatState}
 */
export const putSubagentSession = (state, session) => ({
  ...state,
  subagents: { ...state.subagents,
    sessions: { ...state.subagents.sessions, [session.sessionId]: session } },
});

/**
 * @param {ChatState} state
 * @param {string} sessionId
 * @param {(mm: ChatMessage) => ChatMessage} mapFn
 * @returns {ChatState}
 */
const patchSubagentMessages = (state, sessionId, mapFn) => {
  const session = state.subagents.sessions[sessionId];
  if (!session) return state;
  return putSubagentSession(state, { ...session, messages: session.messages.map(mapFn) });
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
    case 'turn/subagent-start': {
      // why these casts: a subagent-start message always carries a string
      // sessionId (and parentToolUseId when present) by contract — the
      // permissive ReducerMsg types them optional, so name the invariant.
      const sid = /** @type {string} */ (msg.sessionId);
      return { ...state, subagents: { ...state.subagents,
        byToolUse: msg.parentToolUseId
          ? { ...state.subagents.byToolUse, [msg.parentToolUseId]: sid }
          : state.subagents.byToolUse,
        // Seed an empty shell so an expanded card shows "running…" before
        // the first state push lands.
        sessions: state.subagents.sessions[sid]
          ? state.subagents.sessions
          : { ...state.subagents.sessions,
              [sid]: { sessionId: sid, kind: 'subagent', depth: msg.depth, task: msg.task, messages: [] } } } };
    }
    case 'turn/subagent-state':
      return putSubagentSession(state, msg.session);
    case 'turn/subagent-delta':
      return patchSubagentMessages(state, /** @type {string} */ (msg.sessionId), (mm) =>
        mm.id === msg.messageId ? { ...mm, content: (mm.content ?? '') + msg.text } : mm);
    case 'turn/subagent-stop':
      return patchSubagentMessages(state, /** @type {string} */ (msg.sessionId), (mm) =>
        mm.id === msg.messageId ? { ...mm, streaming: false, stopReason: msg.stopReason } : mm);
    case 'turn/subagent-error':
      return patchSubagentMessages(state, /** @type {string} */ (msg.sessionId), (mm) =>
        mm.id === msg.messageId ? { ...mm, streaming: false, error: msg.error } : mm);
    case 'turn/subagent-tool-use':
    case 'turn/subagent-tool-result':
    case 'turn/subagent-done':
      // The turn/subagent-state pushes carry the authoritative message array;
      // these are live complements we don't fold separately.
      return state;
    // DESIGN-17 P1 glass pane — the actor DISPLAY stream (parallel to subagents,
    // keyed by the message_actor tool_use id). Each event carries parentToolUseId
    // so there is no viewed-session guard: an actor card renders regardless of
    // which chat is in view (it belongs to the orchestrator's transcript).
    case 'turn/actor-start':
      return putActorCard(state, /** @type {string} */ (msg.parentToolUseId), {
        sessionId: msg.sessionId, kind: msg.kind, instanceId: msg.instanceId, name: msg.name,
        fromIndex: msg.fromIndex ?? 0, messages: [], streaming: true, error: null, cost: null,
      });
    case 'turn/actor-state': {
      // The full actor-session snapshot; slice to this card's exchange (fromIndex).
      const existing = /** @type {any} */ (state.actors)[/** @type {string} */ (msg.parentToolUseId)];
      // Self-seed when the panel connected mid-turn and missed turn/actor-start
      // (the state push carries fromIndex/kind/… for exactly this); without fromIndex
      // we can't place the slice, so drop.
      const fromIndex = existing?.fromIndex ?? msg.fromIndex;
      if (fromIndex == null) return state;
      const messages = Array.isArray(msg.session?.messages) ? msg.session.messages.slice(fromIndex) : (existing?.messages ?? []);
      const seed = existing ? {} : { fromIndex, kind: msg.kind, instanceId: msg.instanceId, name: msg.name, streaming: true, error: null, cost: null };
      return putActorCard(state, /** @type {string} */ (msg.parentToolUseId), { ...seed, messages });
    }
    case 'turn/actor-error':
      return putActorCard(state, /** @type {string} */ (msg.parentToolUseId), { error: msg.error, streaming: false });
    case 'turn/actor-done': {
      // An ABORT (Stop cascade) → 'cancelled' card; a clean failure with no error
      // already folded → mark failed; else just stop the spinner. Short-circuit when
      // the card is already terminal (turn/actor-error folded first) to avoid churn.
      const card = /** @type {any} */ (state.actors)[/** @type {string} */ (msg.parentToolUseId)];
      if (!card || card.streaming === false) return state;
      /** @type {Record<string, unknown>} */
      const patch = { streaming: false };
      if (msg.aborted) patch.aborted = true;
      else if (msg.ok === false && !card.error) patch.error = 'the actor turn did not complete';
      return putActorCard(state, /** @type {string} */ (msg.parentToolUseId), patch);
    }
    case 'turn/actor-cost': {
      // Phase K: the actor turn's spend, surfaced on its card (delegated work
      // isn't free — make it visible even though caps stay per-session).
      // why the guard: a cost event must only UPDATE an existing card, never
      // create one. onCost fires on every usage event, so a panel that connects
      // mid-turn can see cost before turn/actor-start; self-seeding a card with
      // {cost} and no `streaming` renders a premature green 'ok' and then blocks
      // turn/actor-state's seed (its `existing ? {} : …` gate) from ever applying
      // streaming/kind/name. Let turn/actor-start|state own creation.
      const id = /** @type {string} */ (msg.parentToolUseId);
      if (!(/** @type {any} */ (state.actors)[id])) return state;
      return putActorCard(state, id, { cost: msg.cost });
    }
    case 'async-tasks/update':
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
      const stillHalted = !sessionChanged && state.cost.limitReached;
      const keepSpendError = !sessionChanged && state.lastError === 'spend-limit-reached';
      // why prune on switch: actors/subagents/asyncTasks are keyed by tool_use id
      // and belong to the orchestrator transcript being navigated AWAY from — the
      // state snapshot never carries them, so without this they survive into the
      // new chat (never rendering — renderActorCard matches by viewed tool_use id —
      // but accumulating for the panel's lifetime). A still-live one re-seeds via
      // turn/actor-state on switch-back. Only on an ACTUAL switch, not every push.
      const pruneProjections = sessionChanged
        ? { actors: INITIAL_STATE.actors, subagents: INITIAL_STATE.subagents, asyncTasks: INITIAL_STATE.asyncTasks }
        : {};
      return { ...state, ...msg.state, ...pruneProjections, pendingConfirm: state.pendingConfirm,
        lastError: keepSpendError ? 'spend-limit-reached' : null, rateLimit: null, cost: { ...state.cost,
        session: msg.state?.session?.cost ?? state.cost.session,
        limitUsd: msg.state?.settings?.spendLimitUsd ?? state.cost.limitUsd,
        limitReached: stillHalted } };
    }
    case 'turn/state':
      // Per-session guard: a turn streaming in a BACKGROUND chat must not snap
      // the view to its transcript. Null current = fresh surface adopting it.
      if (state.session.sessionId && state.session.sessionId !== msg.session.sessionId) return state;
      return { ...state, session: { ...state.session,
        sessionId: msg.session.sessionId, messages: msg.session.messages }, lastError: null };
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
      return { ...state, pendingConfirm: msg.prompt };
    case 'confirm/resolved':
      // Answered on another surface (DESIGN-12) — dismiss the same prompt.
      return state.pendingConfirm?.id === msg.id ? { ...state, pendingConfirm: null } : state;
    case 'turn/system-note':
      return { ...state, notices: [...state.notices,
        { id: Date.now() + Math.random(), text: msg.text, action: msg.action ?? null }].slice(-3) };
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
        // already anchored there).
        if (state.agentTabEvents[idx].turnId === turnId) return { ...state, agentTab: tab };
        const events = state.agentTabEvents.map((e, i) => (i === idx ? { ...e, turnId } : e));
        return { ...state, agentTab: tab, agentTabEvents: events };
      }
      // A NEW tab → mint a notice ONLY if peerd opened it (not when the agent
      // merely acted on a tab the user opened — opened:false).
      if (tab.opened === false) return { ...state, agentTab: tab };
      const ev = {
        key: `${sid ?? 's'}:${tab.tabId}`,
        sessionId: sid, tabId: tab.tabId, windowId: tab.windowId ?? null,
        kind: tab.kind ?? null, name: tab.name ?? null, label: tab.label ?? null,
        turnId,
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
