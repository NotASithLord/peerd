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

export const RALPH_LOG_MAX = 50;

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
 * @property {Readonly<Record<string, unknown>>} asyncTasks
 * @property {{ state: any, summary: any, log: any[] }} ralph
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
  // In-flight async subagents (DESIGN-11), keyed by PARENT session id.
  asyncTasks: Object.freeze({}),
  // Ralph persistent-loop status surface (channel: 'ralph').
  ralph: Object.freeze({ state: null, summary: null, log: [] }),
});

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

/**
 * Fold one SW-pushed message into UI state. Pure; see the module header for
 * the side effects that deliberately stay in each surface.
 * @param {ChatState} state
 * @param {ReducerMsg} msg
 * @returns {ChatState} the new state (or `state` unchanged when nothing folds)
 */
export const reduceChat = (state, msg) => {
  if (!msg || typeof msg.type !== 'string') return state;

  // Ralph loop events ride a dedicated channel: fold the authoritative
  // LoopState/summary + a bounded log line.
  if (msg.channel === 'ralph') {
    const prev = state.ralph ?? { state: null, summary: null, log: [] };
    // why: ...msg already carries `type`, so don't restate it (the spread
    // would just overwrite an explicit key with the same value).
    const log = [...prev.log, { t: Date.now(), ...msg }].slice(-RALPH_LOG_MAX);
    return { ...state, ralph: { state: msg.state ?? prev.state, summary: msg.summary ?? prev.summary, log } };
  }

  switch (msg.type) {
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
    case 'async-tasks/update':
      return { ...state, asyncTasks: { ...state.asyncTasks,
        [/** @type {string} */ (msg.parentSessionId)]: msg.tasks } };
    case 'state':
      // Full snapshot. Replace, seeding the cost meter from the persisted
      // session tally + the configured limit. (Voice-restore is the surface's
      // job — see the module header.) why preserve pendingConfirm: confirm
      // state is owned by the confirm/request|resolved channel, NOT the
      // snapshot (it carries null) — folding ...msg.state must never wipe a
      // live prompt a 'state' push races with (DESIGN-12).
      return { ...state, ...msg.state, pendingConfirm: state.pendingConfirm, lastError: null, cost: { ...state.cost,
        session: msg.state?.session?.cost ?? state.cost.session,
        limitUsd: msg.state?.settings?.spendLimitUsd ?? state.cost.limitUsd,
        limitReached: false } };
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
      // The turn the agent is acting in RIGHT NOW — its starting user message. The
      // notice anchors here and renders at that turn's END, so later messages push
      // it down.
      const msgs = state.session.messages;
      let turnId = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const mm = msgs[i];
        const toolResultOnly = (!mm.content || mm.content === '')
          && Array.isArray(mm.toolResults) && mm.toolResults.length > 0;
        if (mm.role === 'user' && !mm.synthetic && !toolResultOnly) { turnId = mm.id; break; }
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
