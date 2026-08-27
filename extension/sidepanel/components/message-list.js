// @ts-check
// Message list — keyed render of session.messages.
//
// Two structural rules unique to this list:
//
// 1. The agent loop produces tool_use blocks (on assistant messages) and
//    tool_result blocks (on a follow-up user message with content: '').
//    The tool-result user message is a transport artifact, not a thing
//    the human said. We hide it from the visual list entirely and pair
//    its results with the previous assistant message's tool_use blocks
//    (matched by tool_use_id) so the result is shown alongside the call.
//
// 2. Tool calls render inline as cards under the assistant message that
//    issued them. Each card shows the §02 lineage by default:
//      ▼ tool_name({args summary})
//         primitive : inspect / tab / web / time / webvm
//         gates     : persona ✓ exposure ✓ origin ✓ confirm ✓ egress ✓ audit ✓
//         result    : { ... }    [expand]
//         took      : 12ms
//
// Collapsed by default. Devs immediately understand what's happening;
// new users learn the model by exposure. "The architecture is legible
// in every interaction" — not just on /verify.

import m from '/vendor/mithril/mithril.js';
import { renderMarkdown } from '/shared/markdown.js';
import { stripUntrustedFences } from '/shared/util.js';
import { CHANNEL } from '/shared/channel-config.js';
import { classifyFailure, contributorFeedbackTargets, formatBytes } from '/peerd-runtime/ui.js';

// `performed:false` is host custody metadata. Error bodies are not: provider,
// actor, and page text can all flow into them. Keep the human recovery generic
// unless a future host-only typed reason is carried alongside the custody bit.
const ACTOR_NOT_RUN_USER_FAILURE =
  'No actor work was started. Review the request before trying again.';

/** @param {string} _text @returns {string} */
const actorOutcomeUnknownFailure = (_text) =>
  'peerd cannot confirm whether the actor ran or completed. Check the target before trying again.';

/** @typedef {import('../chat-reducer.js').ChatMessage} ChatMessage */
/** @typedef {import('../chat-reducer.js').SpawnedSession} SpawnedSession */

/** @typedef {Record<string, ((...args: any[]) => any) | undefined>} UiActions */

/**
 * One tool_use block on an assistant message.
 * @typedef {{ id: string, name: string, input?: Record<string, unknown> }} ToolUse
 */

/**
 * A tool_result block (JSON-string content + lineage meta).
 * @typedef {Object} ToolResult
 * @property {string} [tool_use_id]
 * @property {boolean} [is_error]
 * @property {string} [content]
 * @property {boolean} [actorTerminal]
 * @property {boolean} [actorOutcomeKnown]
 * @property {boolean} [actorPerformed]
 * @property {boolean} [actorAborted]
 * @property {string} [actorCorrelationId]
 * @property {string} [actorDeliveryId]
 * @property {string[]} [actorDeliveryIds]
 * @property {{ primitive?: string, durationMs?: number, dispatch?: string, gates: Array<{ name: string, reason: string, allowed: boolean }>, browserPolicies?: Array<{ reason: string, outcome: string, child: string, retryable: boolean }> }|null} [meta]
 */

/** @typedef {{ toolUse: ToolUse, toolResult: ToolResult|null }} PairedTool */

/**
 * An inline "peerd opened a tab" notice event.
 * @typedef {Object} TabEvent
 * @property {string} key
 * @property {string|null} [sessionId]
 * @property {number} tabId
 * @property {number|null} [windowId]
 * @property {string|null} [kind]
 * @property {string|null} [name]
 * @property {string|null} [label]
 * @property {boolean} [protected]
 * @property {string|null} [turnId]
 */

/**
 * Args shared by the recursive transcript renderer.
 * @typedef {Object} TranscriptArgs
 * @property {ChatMessage[]} [messages]
 * @property {Record<string, { stdout: string, stderr: string }>} [vmStreams]
 * @property {{ byToolUse?: Record<string, string>, sessions?: Record<string, SpawnedSession> }} [spawned]
 * @property {Record<string, any>} [actors]
 * @property {Record<string, any[]>} [scriptOps]
 * @property {(sessionId: string) => void} [loadActor]
 * @property {string} [peerName]
 * @property {number} [depth]
 * @property {TabEvent[]} [tabEvents]
 * @property {{ id: string, sessionId: string|null, text: string, at: number }[]} [confirmEvents]
 * @property {UiActions} [uiActions]
 * @property {string} [sessionId]
 * @property {((msg: Record<string, any>) => Promise<any>)} [send]
 * @property {boolean} [busy]
 * @property {boolean} [announceOnMount]
 * @property {Map<string|undefined, Set<string>>} [seenRecoveryIdsBySession]
 */

// Auto-scroll heuristic: if the user is reading near the bottom, keep
// them pinned at the bottom across all updates (new messages, growing
// tool calls, streaming text deltas). If they've scrolled away to read
// older content, respect their scroll position.
//
// "Near the bottom" = within 150px. Generous enough that the
// expand-result affordance doesn't fight scroll, tight enough that an
// intentional scroll-up keeps the user where they want.
const NEAR_BOTTOM_PX = 150;
/** @param {HTMLElement} el */
const scrollIfNearBottom = (el) => {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distance < NEAR_BOTTOM_PX) el.scrollTop = el.scrollHeight;
};

// How many levels of nested actor transcript to render inline before
// stopping. Deeper runs still exist and are inspectable, but rendering
// them inline would explode the layout. See docs/ACTORS.md.
const MAX_NESTED_DEPTH = 5;
const CONTRIBUTOR_FEEDBACK_ENABLED = CHANNEL === 'preview' || CHANNEL === 'dev';

// Render one transcript (a flat message array) as keyed user/assistant
// rows. Shared between the top-level chat and every nested actor
// transcript — an actor_create card renders its child by calling this
// again at depth+1, so the structure is naturally recursive.
/**
 * @param {TranscriptArgs} args
 * @returns {any[]}
 */
const renderTranscript = ({ messages, vmStreams, spawned, actors, scriptOps, loadActor, peerName, depth = 0, tabEvents = [], confirmEvents = [], uiActions, send, sessionId, busy = false }) => {
  const groups = groupMessages(messages ?? []);
  // Feedback belongs to the completed answer for a human turn, not every
  // intermediate assistant step before a tool call. The live answer becomes
  // eligible only after the authoritative turn slot is idle.
  const feedbackMessageIds = busy || !CONTRIBUTOR_FEEDBACK_ENABLED
    ? new Set()
    : new Set(contributorFeedbackTargets(messages ?? []).keys());
  // Inline "peerd opened a tab" notices (top level only), bucketed by the TURN
  // (its starting user-message id) they belong to. They render at the END of that
  // turn — after the agent's later messages — then freeze above the next turn.
  /** @type {Map<string|null|undefined, TabEvent[]>} */
  const byTurn = new Map();
  if (depth === 0) {
    for (const ev of tabEvents) {
      const list = byTurn.get(ev.turnId) ?? [];
      list.push(ev);
      byTurn.set(ev.turnId, list);
    }
  }
  /** @type {any[]} */
  const out = [];
  /** @type {string|null} */
  let curTurn = null;          // the turn-start user id we're currently inside
  /**
   * @param {string|null|undefined} turnId
   * @param {boolean} fresh
   */
  const flush = (turnId, fresh) => {
    const evs = byTurn.get(turnId);
    if (!evs) return;
    for (const ev of evs) out.push(m(AgentTabNotice, { key: `tab-${ev.key}`, ev, fresh, uiActions }));
    byTurn.delete(turnId);
  };
  groups.forEach((g) => {
    // Entering a new user turn → flush the PREVIOUS turn's notices first (now
    // muted, pinned just above this user message). An actor-reply is NOT a
    // turn anchor — it lands mid-conversation, inside the user's ongoing turn.
    if (g.type === 'user') { flush(curTurn, false); curTurn = g.message.id; }
    out.push(g.type === 'user'
      ? m(UserMessage, { key: g.message.id, message: g.message })
      : g.type === 'actor-reply'
        ? m(ActorReplyMessage, { key: g.message.id, message: g.message, uiActions })
        : m(AssistantMessage, {
            key: g.message.id, message: g.message, toolResults: g.toolResults,
            vmStreams, spawned, actors, scriptOps, loadActor, peerName, depth,
            send, sessionId, allowFeedback: feedbackMessageIds.has(g.message.id),
          }));
  });
  // The current (last) turn's notices render at the very end — fresh; any with an
  // unmatched turn (e.g. opened before the first user message) trail after.
  if (depth === 0) {
    flush(curTurn, true);
    for (const ev of tabEvents) flush(ev.turnId, true);
    // Confirm settles trail last (§4e): a settle happens at the live turn's
    // edge, so the tail is its honest anchor - newest of the capped few wins
    // the fresh treatment.
    confirmEvents.forEach((ev, i) => out.push(m(ConfirmSettledNotice, {
      key: `confirm-${ev.id}`, ev, fresh: i === confirmEvents.length - 1,
    })));
  }
  return out;
};

/** @param {ChatMessage} message @returns {Array<{ id: string, announcement: string }>} */
const recoveryReceiptsForMessage = (message) => {
  /** @type {Array<{ id: string, announcement: string }>} */
  const receipts = [];
  const messageId = typeof message.id === 'string' ? message.id : null;
  if (message.actorReply?.outcomeKnown === false) {
    if (messageId) receipts.push({
      id: `${messageId}:actor-reply`,
      announcement: 'Actor outcome unknown. Check the target before trying again.',
    });
  } else if (message.actorReply?.performed === false) {
    if (messageId) receipts.push({
      id: `${messageId}:actor-reply`,
      announcement: 'Actor request not run. Re-issue it if it still matters.',
    });
  }
  for (const rawResult of Array.isArray(message.toolResults) ? message.toolResults : []) {
    const result = /** @type {any} */ (rawResult);
    const content = typeof result?.content === 'string'
      ? result.content
      : JSON.stringify(result?.content ?? '');
    if (result?.is_error === true
      && /outcome is unknown|outcome unknown/i.test(content)
      && messageId
      && typeof result?.tool_use_id === 'string') {
      receipts.push({
        id: `${messageId}:tool-result:${result.tool_use_id}`,
        announcement: 'Actor outcome unknown. Check the target before trying again.',
      });
    }
  }
  return receipts;
};

/** @param {ChatMessage[]|undefined} messages */
const recoveryReceipts = (messages) => (messages ?? []).flatMap(recoveryReceiptsForMessage);

/** @param {any} state @param {TabEvent[]|undefined} tabEvents */
const freshTabAnnouncements = (state, tabEvents) => {
  const announcements = [];
  for (const event of tabEvents ?? []) {
    const isProtected = event.protected !== false;
    if (state.seenTabEventStates.has(event.key)
        && state.seenTabEventStates.get(event.key) === isProtected) continue;
    state.seenTabEventStates.set(event.key, isProtected);
    announcements.push(!isProtected
      ? 'peerd left a blank tab because browser control was not confirmed. Close it before continuing. Use Go to focus it.'
      : 'peerd opened a task tab with additional browser safeguards. Use Go to focus it.');
  }
  return announcements;
};

/** @param {any} state @param {string} announcement */
const replaceRecoveryAnnouncement = (state, announcement) => {
  if (state.recoveryAnnouncementTimer) {
    clearTimeout(state.recoveryAnnouncementTimer);
    state.recoveryAnnouncementTimer = null;
  }
  state.recoveryAnnouncement = announcement;
};

/** @param {any} state */
const scheduleRecoveryAnnouncementClear = (state) => {
  const announced = state.recoveryAnnouncement;
  if (!announced || state.recoveryAnnouncementTimer) return;
  state.recoveryAnnouncementTimer = setTimeout(() => {
    state.recoveryAnnouncementTimer = null;
    if (state.recoveryAnnouncement === announced) {
      state.recoveryAnnouncement = '';
      m.redraw();
    }
  }, 1_000);
};

export const MessageList = {
  /** @param {{ attrs: TranscriptArgs, state: any }} vnode */
  oninit(vnode) {
    vnode.state.sessionId = vnode.attrs.sessionId;
    // Existing history on the initial mount is a visual receipt, not a new
    // alert. Keep the baseline per session after that: a receipt first
    // encountered when the user switches chats is new to this surface and must
    // be announced, while switching back must not announce it again.
    vnode.state.seenRecoveryIdsBySession = vnode.attrs.seenRecoveryIdsBySession ?? new Map();
    const receipts = recoveryReceipts(vnode.attrs.messages);
    const existing = vnode.state.seenRecoveryIdsBySession.get(vnode.attrs.sessionId);
    const fresh = existing
      ? receipts.filter((receipt) => !existing.has(receipt.id))
      : vnode.attrs.announceOnMount ? receipts : [];
    const seen = existing ?? new Set();
    for (const receipt of receipts) seen.add(receipt.id);
    vnode.state.seenRecoveryIdsBySession.set(vnode.attrs.sessionId, seen);
    // Existing tab receipts are history. Announce only events added after this
    // list mounts. Track the host-stamped key and containment state so a later
    // downgrade from protected to blank is announced instead of deduplicated.
    vnode.state.seenTabEventStates = new Map((vnode.attrs.tabEvents ?? [])
      .map((event) => [event.key, event.protected !== false]));
    vnode.state.recoveryAnnouncement = fresh.map((receipt) => receipt.announcement).join(' ');
    vnode.state.recoveryAnnouncementTimer = null;
  },
  /** @param {{ attrs: TranscriptArgs, state: any }} vnode */
  onbeforeupdate(vnode) {
    if (vnode.state.sessionId !== vnode.attrs.sessionId) {
      vnode.state.sessionId = vnode.attrs.sessionId;
      const receipts = recoveryReceipts(vnode.attrs.messages);
      const existing = vnode.state.seenRecoveryIdsBySession.get(vnode.attrs.sessionId);
      const fresh = existing
        ? receipts.filter((receipt) => !existing.has(receipt.id))
        : receipts;
      const seen = existing ?? new Set();
      for (const receipt of receipts) seen.add(receipt.id);
      vnode.state.seenRecoveryIdsBySession.set(vnode.attrs.sessionId, seen);
      for (const event of vnode.attrs.tabEvents ?? []) {
        vnode.state.seenTabEventStates.set(event.key, event.protected !== false);
      }
      replaceRecoveryAnnouncement(vnode.state, fresh
        .map((receipt) => receipt.announcement)
        .join(' '));
      return true;
    }
    const seen = vnode.state.seenRecoveryIdsBySession.get(vnode.attrs.sessionId) ?? new Set();
    const receipts = recoveryReceipts(vnode.attrs.messages);
    const fresh = receipts.filter((receipt) => !seen.has(receipt.id));
    const tabAnnouncements = freshTabAnnouncements(vnode.state, vnode.attrs.tabEvents);
    for (const receipt of receipts) seen.add(receipt.id);
    vnode.state.seenRecoveryIdsBySession.set(vnode.attrs.sessionId, seen);
    if (fresh.length > 0 || tabAnnouncements.length > 0) {
      replaceRecoveryAnnouncement(vnode.state, [
        ...fresh.map((receipt) => receipt.announcement),
        ...tabAnnouncements,
      ].join(' '));
    }
    return true;
  },
  // Initial mount: jump to the bottom so existing-session render starts
  // with the latest turn visible, not the first message.
  /** @param {{ dom: HTMLElement, state: any }} vnode */
  oncreate(vnode) {
    vnode.dom.scrollTop = vnode.dom.scrollHeight;
    scheduleRecoveryAnnouncementClear(vnode.state);
  },
  /** @param {{ dom: HTMLElement, state: any }} vnode */
  onupdate(vnode) {
    scrollIfNearBottom(vnode.dom);
    scheduleRecoveryAnnouncementClear(vnode.state);
  },
  /** @param {{ state: any }} vnode */
  onremove(vnode) {
    if (vnode.state.recoveryAnnouncementTimer) clearTimeout(vnode.state.recoveryAnnouncementTimer);
  },

  /** @param {{ attrs: TranscriptArgs, state: any }} vnode */
  view: ({ attrs: { messages, vmStreams, spawned, actors, scriptOps, loadActor, peerName, tabEvents, confirmEvents, uiActions, send, sessionId, busy }, state }) =>
    m('.message-list', [
      renderTranscript({
        messages, vmStreams, spawned, actors, scriptOps, loadActor, peerName,
        depth: 0, tabEvents, confirmEvents, uiActions, send, sessionId, busy,
      }),
      state.recoveryAnnouncement
        ? m('span.sr-only.actor-recovery-announcement.message-list-announcement', {
            role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true',
          }, state.recoveryAnnouncement)
        : null,
    ]),
};

// Inline "peerd opened a tab" notice — anchored at the turn it happened so it
// scrolls into the backlog as the chat continues (replaces the old bright,
// sticky agent-tab card; DECISIONS #26 / owner's call). Quiet by default; the
// current turn's notice gets a subtle, NON-accent highlight, then mutes. "Go ↗"
// focuses the tab (and, from home, opens the panel) — best-effort: a click on a
// since-closed tab is a harmless no-op.
const AgentTabNotice = {
  /** @param {{ attrs: { ev: TabEvent, fresh: boolean, uiActions?: UiActions } }} vnode */
  view: ({ attrs: { ev, fresh, uiActions } }) => {
    const label = (ev.kind && ev.name) ? `${ev.kind} · ${ev.name}` : (ev.label || 'a tab');
    const protectedTab = ev.protected !== false;
    return m(`.agent-tab-notice${fresh ? '.agent-tab-notice--fresh' : ''}`, [
      m('span.agent-tab-notice-icon', { 'aria-hidden': 'true' }, '▦'),
      m('span.agent-tab-notice-copy', [
        m('span.agent-tab-notice-text', [
          protectedTab ? 'peerd opened a task tab · ' : 'peerd left a blank tab · ',
          m('span.agent-tab-notice-label', label),
        ]),
        m('span.agent-tab-notice-detail', protectedTab
          ? 'This task tab uses additional browser safeguards.'
          : 'Browser control was not confirmed. Close this tab before continuing.'),
      ]),
      m('button.agent-tab-notice-go', {
        type: 'button',
        title: 'Go to this tab',
        'aria-label': `Go to ${protectedTab ? 'task' : 'blank'} tab: ${label}`,
        onclick: () => uiActions?.openAgentTab?.(ev.tabId, ev.windowId),
      }, 'Go ↗'),
    ]);
  },
};

// One quiet row per confirm that settled without this surface's click (§4e) -
// timeout, Stop, closed panel, or answered elsewhere. Same visual family as
// the tab notice above: informational, never a control, role=status so a live
// settle is announced without stealing focus.
const ConfirmSettledNotice = {
  /** @param {{ attrs: { ev: { id: string, text: string }, fresh: boolean } }} vnode */
  view: ({ attrs: { ev, fresh } }) => m(`.agent-tab-notice.confirm-settled-notice${fresh ? '.agent-tab-notice--fresh' : ''}`, {
    role: 'status',
  }, [
    m('span.agent-tab-notice-icon', { 'aria-hidden': 'true' }, '▣'),
    m('span.agent-tab-notice-copy', m('span.agent-tab-notice-text', ev.text)),
  ]),
};

/**
 * Walk session.messages and produce a display-friendly grouping:
 *   - user messages with actual text: shown as user bubble
 *   - tool-result-only user messages (content: '', toolResults present):
 *     attached to the previous assistant message by lookup; skipped from
 *     the list directly
 *   - assistant messages: shown with their tool_use blocks paired to
 *     matching tool_results (by tool_use_id) from the next message if any
 */
/**
 * @param {ChatMessage[]} messages
 * @returns {Array<{ type: 'user', message: ChatMessage } | { type: 'actor-reply', message: ChatMessage } | { type: 'assistant', message: ChatMessage, toolResults: PairedTool[] }>}
 */
const groupMessages = (messages) => {
  /** @type {Array<{ type: 'user', message: ChatMessage } | { type: 'actor-reply', message: ChatMessage } | { type: 'assistant', message: ChatMessage, toolResults: PairedTool[] }>} */
  const out = [];
  /** @type {Map<string, PairedTool[]>} */
  const unmatchedByToolUseId = new Map();
  for (const msg of messages) {
    if (msg.role === 'user') {
      // Pair each result with the closest preceding unmatched occurrence. Tool
      // ids are provider-authored and can repeat on later model calls, so a
      // transcript-global id map would attach the newest result to old calls.
      if (Array.isArray(msg.toolResults)) {
        for (const tr of /** @type {ToolResult[]} */ (msg.toolResults)) {
          if (!tr?.tool_use_id) continue;
          const unmatched = unmatchedByToolUseId.get(tr.tool_use_id);
          const pair = unmatched?.pop();
          if (pair) pair.toolResult = tr;
          if (unmatched?.length === 0) unmatchedByToolUseId.delete(tr.tool_use_id);
        }
      }
      const isToolResultOnly = (!msg.content || msg.content === '')
        && Array.isArray(msg.toolResults) && msg.toolResults.length > 0;
      if (isToolResultOnly) continue;
      // An actor's reply-wake is synthetic (machine-delivered) but it IS the
      // news the user is waiting on — surface it as its own attributed bubble
      // at its place in the transcript instead of burying it in the tool card.
      if (msg.synthetic && msg.actorReply) { out.push({ type: 'actor-reply', message: msg }); continue; }
      // Synthetic continuation nudges (agent-loop truncation recovery)
      // are loop plumbing, not something the user typed — the truncated
      // assistant message's stop-reason chip tells the visible story.
      if (msg.synthetic) continue;
      out.push({ type: 'user', message: msg });
    } else if (msg.role === 'assistant') {
      const toolUses = Array.isArray(msg.toolUses) ? /** @type {ToolUse[]} */ (msg.toolUses) : [];
      const paired = /** @type {PairedTool[]} */ (toolUses.map(
        (tu) => ({ toolUse: tu, toolResult: null })));
      for (const pair of paired) {
        const unmatched = unmatchedByToolUseId.get(pair.toolUse.id) ?? [];
        unmatched.push(pair);
        unmatchedByToolUseId.set(pair.toolUse.id, unmatched);
      }
      out.push({ type: 'assistant', message: msg, toolResults: paired });
    }
  }
  return out;
};

/** @typedef {{ name: string, mediaType?: string, size: number }} Attachment */

const UserMessage = {
  /** @param {{ attrs: { message: ChatMessage } }} vnode */
  view: ({ attrs: { message } }) => {
    const cls = `.message.message-user${message.error ? '.failed' : ''}`;
    const attachments = Array.isArray(message.attachments)
      ? /** @type {Attachment[]} */ (message.attachments) : [];
    return m(cls, [
      m('.role', 'you'),
      m('.bubble', [
        // Attached files — name + size chips, live or stripped alike
        // (send-once-then-strip drops the bytes after the first send;
        // the metadata persists precisely so this chip can keep
        // rendering). No thumbnails in v1 — frugal.
        attachments.length > 0
          ? m('.attachment-chips', attachments.map((a) =>
              m('.attachment-chip', {
                title: `${a.name} (${a.mediaType})`,
              }, [
                m('span.attachment-chip-name', a.name),
                m('span.attachment-chip-size', formatBytes(a.size)),
              ])))
          : null,
        renderText(message.content),
        message.error ? m('.error-line', message.error) : null,
      ]),
    ]);
  },
};

/** @typedef {{ group: string|null, headline: string, reason: string, whatIsNotKnown: string, tone: string, action: { label: string, composerText: string } | null }} LandingStopCardModel */

// The origin-lock stop card (§4c): four slots in 3g's fixed order - where it
// stopped, why (the landing rule's verbatim one-liner), what isn't known, and
// what's next. Monochrome: eight of the nine stops are the boundary doing its
// job on ordinary web behaviour, so red would cry wolf - INTERNAL alone (a
// genuine bug) takes the error treatment. The one action fills the composer
// and grants nothing: it types the user's likely next message, calls no tool,
// and never resumes the stopped helper.
const LandingStopCard = {
  /** @param {{ attrs: { card: LandingStopCardModel, uiActions?: UiActions } }} vnode */
  view: ({ attrs: { card, uiActions } }) => m('.message.message-actor-reply.failed', [
    m('.landing-stop-card', { class: card.tone === 'error' ? 'is-error' : '' }, [
      m('.landing-stop-chips', [
        m('span.landing-stop-chip', 'STOPPED'),
        card.group ? m('span.landing-stop-group', card.group) : null,
      ]),
      m('.landing-stop-headline', card.headline),
      card.reason ? m('.landing-stop-reason', card.reason) : null,
      m('.landing-stop-unknown', [
        m('.landing-stop-unknown-label', 'WHAT PEERD DOESN’T KNOW'),
        m('.landing-stop-unknown-text', card.whatIsNotKnown),
      ]),
      card.action ? m('button.landing-stop-action', {
        type: 'button',
        // why prefill, not send: the card must never spend authority - the
        // user reads the typed message and decides to send it themselves.
        onclick: () => uiActions?.prefillComposer?.(card.action?.composerText),
      }, card.action.label) : null,
    ]),
  ]),
};

// An actor's reply, surfaced as its OWN bubble at its place in the transcript
// (the trickle-up: delegated work comes BACK as a visible message, not buried
// in the message_actor card above). Attribution mirrors renderActorCard's
// label rules; the body is the fence-stripped reply (display-only — the model
// still receives the full fenced text). The trusted lead line duplicates the
// attribution label, so it's dropped from the bubble.
const ActorReplyMessage = {
  /** @param {{ attrs: { message: ChatMessage, uiActions?: UiActions } }} vnode */
  view: ({ attrs: { message, uiActions } }) => {
    const reply = message.actorReply ?? /** @type {NonNullable<ChatMessage['actorReply']>} */ ({ kind: 'actor', instanceId: '' });
    // §4c: an origin-lock stop renders as the slotted CARD, not the prose
    // paragraphs - the report text stays the orchestrator's copy, byte-identical.
    const landingStop = /** @type {LandingStopCardModel | undefined} */ (
      /** @type {any} */ (reply).landingStop);
    if (landingStop) return m(LandingStopCard, { card: landingStop, uiActions });
    const who = reply.name ?? (reply.instanceId !== reply.kind ? reply.instanceId : '');
    const label = (reply.kind === 'web' && /^https?:\/\//.test(String(reply.instanceId)))
      ? `${reply.instanceId} integration`
      : `${reply.kind} actor${who ? ` · ${who}` : ''}`;
    const content = String(message.content ?? '');
    // Drop replyText()'s one-line lead ("The <kind> actor … has replied:") —
    // the role label above the bubble already says who this is.
    const body = content.includes('\n\n') ? content.slice(content.indexOf('\n\n') + 2) : content;
    // A Stop with an explicitly unknown outcome is not a clean cancellation;
    // verification guidance must win over the friendlier cancelled label.
    const aborted = reply.aborted === true
      && reply.outcomeKnown !== false && reply.performed !== true;
    const failed = reply.failed === true && !aborted;
    const userFailure = failed && reply.performed === false
      ? ACTOR_NOT_RUN_USER_FAILURE : null;
    const outcomeUnknown = !aborted && reply.outcomeKnown === false;
    const notRun = !outcomeUnknown && reply.performed === false;
    const displayBody = outcomeUnknown
      ? actorOutcomeUnknownFailure(body)
      : (userFailure ?? body);
    // A `via:'script'` reply came from a fire-and-forget delegation inside an
    // earlier script run — it can land minutes later, so name its origin or the
    // bubble is unexplainable to a user who never saw the fan-out happen.
    const via = /** @type {{ via?: string }} */ (reply).via;
    return m(`.message.message-actor-reply${aborted ? '.cancelled' : failed ? '.failed' : ''}`, [
      m('.role', [
        label,
        via === 'script' ? ' · delegated by an earlier script' : '',
        aborted ? ' · cancelled'
          : failed ? ` · ${outcomeUnknown ? 'Outcome unknown' : notRun ? 'Not run' : 'failed'}` : '',
      ]),
      m('.bubble', renderText(stripUntrustedFences(displayBody))),
      ]);
  },
};

const AssistantMessage = {
  /**
   * @param {{ attrs: {
   *   message: ChatMessage, toolResults: PairedTool[],
   *   vmStreams?: Record<string, { stdout: string, stderr: string }>,
   *   spawned?: TranscriptArgs['spawned'],
   *   actors?: Record<string, any>,
   *   scriptOps?: Record<string, any[]>,
   *   loadActor?: (sessionId: string) => void,
   *   peerName?: string, depth?: number,
   *   send?: (msg: Record<string, any>) => Promise<any>, sessionId?: string,
   *   allowFeedback?: boolean,
   * } }} vnode
   */
  view: ({ attrs: { message, toolResults, vmStreams, spawned, actors, scriptOps, loadActor, peerName, depth, send, sessionId, allowFeedback } }) => {
    const hasText = typeof message.content === 'string' && message.content.length > 0;
    const hasToolUses = toolResults.length > 0;
    const hasThinking = typeof message.thinking === 'string' && message.thinking.length > 0;
    const cls = `.message.message-assistant${message.streaming ? '.streaming' : ''}${message.error ? '.failed' : ''}${!hasText && hasToolUses ? '.tools-only' : ''}`;
    return m(cls, [
      // why peerName here and ONLY here: the assistant row label is the
      // single surface the profile's peer name shows on (owner
      // direction: "it will only really reflect in the chat logs").
      // Every other brand surface stays the literal wordmark.
      m('.role', peerName || 'peerd'),
      // Chain-of-reasoning (extended thinking), when the provider emitted
      // it. Renders above the answer as a collapsible section — open
      // while the model is still only thinking, folds away once the
      // answer text starts. why: unkeyed (positional identity) so it
      // doesn't break the keyed/unkeyed rule against its siblings.
      hasThinking
        ? m(Reasoning, { text: message.thinking, streaming: !!message.streaming, hasText })
        : null,
      // Waiting on the first token → the bare beachball, no bubble
      // chrome around it (owner polish 2026-06-12: a spinner isn't a
      // message, so it doesn't get a message's outline).
      (!hasText && message.streaming)
        ? m('.thinking-solo', m(ThinkingSpinner))
        : hasText
          ? m('.bubble', [
              renderText(message.content, { markdown: true }),
              message.error ? m('.error-line', message.error) : null,
            ])
          // why: a turn can FAIL before any token streams (e.g. an Anthropic
          // usage-limit on send). Without this branch the error-line only
          // rendered inside the hasText bubble, so an empty errored turn drew
          // nothing — the failure was invisible in the transcript ("fails
          // silently"). Render a bare error bubble so it's always surfaced.
          : message.error
            ? m('.bubble.bubble-error', m('.error-line', message.error))
            : null,
      // Failure-class chip — the classified NEIGHBORHOOD of a failed turn
      // (policy / provider / timeout / …), so a user triaging doesn't have
      // to parse the raw error to know whose fault it roughly was.
      message.error
        ? m('span.failure-kind-chip',
            { title: 'failure class' },
            classifyFailure(message.error, { stopReason: message.stopReason }).kind)
        : null,
      // Stop-reason chip — truncations and caps must never be silent.
      // max_tokens with neither text nor tools = the thinking-only
      // truncation the loop auto-continues; say so. max_steps = the
      // step cap (send again to keep going).
      message.stopReason === 'max_tokens'
        ? m('.stop-chip', (message.content || '').trim() === '' && !hasToolUses
            ? '⚠ output limit hit during reasoning — continuing automatically'
            : '⚠ output limit reached — response may be cut short')
        : message.stopReason === 'max_steps'
          ? m('.stop-chip', '⚠ step cap reached — send a message to continue')
          : message.stopReason === 'aborted'
            ? m('.stop-chip', '⏹ stopped')
            : null,
      // Tool calls render below the text bubble (or alone if there's
      // no text).
      hasToolUses
        ? m('.tool-calls', toolResults.map(({ toolUse, toolResult }) =>
            m(ToolCall, {
              key: toolUse.id,
              toolUse,
              toolResult,
              // an aborted turn never produced this tool's result — render it
              // 'cancelled', not a perpetual 'running…' (see ToolCall).
              interrupted: message.stopReason === 'aborted',
              liveStream: vmStreams?.[toolUse.id] ?? null,
              spawned,
              actors,
              scriptOps,
              loadActor,
              peerName,
              depth: depth ?? 0,
            })
          ))
        : null,
      CONTRIBUTOR_FEEDBACK_ENABLED && depth === 0 && allowFeedback
        && hasText && !message.streaming && !message.error && send && sessionId
        ? m(TaskFeedback, { messageId: message.id, sessionId, send })
        : null,
    ]);
  },
};

// Optional binary task feedback. The route re-derives the selected assistant
// turn and cohort, so the DOM cannot submit a cohort, counter, or arbitrary
// text. Selection changes only after the host confirms the write.
const TaskFeedback = {
  /** @param {{ state: any }} vnode */
  oninit(vnode) {
    vnode.state.selection = null;
    vnode.state.busy = false;
    vnode.state.notice = null;
  },
  /** @param {{ state: any, attrs: { messageId: string, sessionId: string, send: (msg: Record<string, any>) => Promise<any> } }} vnode */
  view(vnode) {
    /** @param {'worked'|'didnt_work'} verdict */
    const choose = async (verdict) => {
      if (vnode.state.busy) return;
      vnode.state.busy = true;
      vnode.state.notice = null;
      m.redraw();
      try {
        const reply = await vnode.attrs.send({
          type: 'contributor/feedback',
          sessionId: vnode.attrs.sessionId,
          messageId: vnode.attrs.messageId,
          verdict,
        });
        if (reply?.ok === true && reply?.reason == null) {
          vnode.state.selection = verdict;
        } else {
          vnode.state.notice = reply?.reason === 'disabled'
            ? 'enable Contributor Metrics in Settings to record feedback'
            : 'feedback was not recorded';
        }
      } catch {
        vnode.state.notice = 'feedback was not recorded';
      }
      vnode.state.busy = false;
      m.redraw();
    };
    return m('.task-feedback', { role: 'group', 'aria-label': 'Was this response useful?' }, [
      m('span', 'did this work?'),
      m('button', {
        type: 'button', class: vnode.state.selection === 'worked' ? 'is-selected' : '',
        'aria-pressed': vnode.state.selection === 'worked' ? 'true' : 'false',
        disabled: vnode.state.busy,
        onclick: () => choose('worked'),
      }, 'worked'),
      m('button', {
        type: 'button', class: vnode.state.selection === 'didnt_work' ? 'is-selected' : '',
        'aria-pressed': vnode.state.selection === 'didnt_work' ? 'true' : 'false',
        disabled: vnode.state.busy,
        onclick: () => choose('didnt_work'),
      }, 'didn’t work'),
      vnode.state.notice
        ? m('span.task-feedback-note', { role: 'status' }, vnode.state.notice)
        : null,
    ]);
  },
};

// ─── Thinking spinner ────────────────────────────────────────────────────
//
// The peerd orb: a rainbow RING where the five brand colors sweep through one
// conic gradient, masked to a hollow ring (see .peerd-spinner in styles.css).
// A single div — the gradient, mask, and spin are CSS-only and disabled under
// prefers-reduced-motion.
//
// attrs.sm → a smaller variant for inline use (the Reasoning header).
const ThinkingSpinner = {
  /** @param {{ attrs?: { sm?: boolean } }} vnode */
  view: ({ attrs }) =>
    m(`.peerd-spinner${attrs && attrs.sm ? '.peerd-spinner--sm' : ''}`,
      { role: 'status', 'aria-label': 'Working…' }),
};

// ─── Reasoning (extended thinking) section ───────────────────────────────
//
// Collapsible chain-of-reasoning shown above the answer. Auto-opens
// while the model is still thinking (streaming, no answer text yet) so
// the user watches the plan form; auto-collapses the moment the answer
// begins. Once the user clicks the header their choice sticks.
/** @typedef {{ userToggled: boolean, expanded: boolean }} ReasoningState */

const Reasoning = {
  /** @param {{ state: ReasoningState }} vnode */
  oninit(vnode) { vnode.state.userToggled = false; vnode.state.expanded = false; },
  /**
   * @param {{
   *   attrs: { text?: string, streaming: boolean, hasText: boolean },
   *   state: ReasoningState,
   * }} vnode
   */
  view: ({ attrs: { text, streaming, hasText }, state: ui }) => {
    const thinkingNow = streaming && !hasText;
    const expanded = ui.userToggled ? ui.expanded : thinkingNow;
    return m(`.reasoning${thinkingNow ? '.reasoning-active' : ''}`, [
      m('.reasoning-header', {
        onclick: () => { ui.userToggled = true; ui.expanded = !expanded; },
      }, [
        m('span.disclosure', expanded ? '▼' : '▶'),
        m('span.reasoning-label', 'Reasoning'),
        thinkingNow ? m(ThinkingSpinner, { sm: true }) : null,
      ]),
      expanded ? m('.reasoning-body', text) : null,
    ]);
  },
};

// Render message text. Assistant replies are rendered as Markdown
// (renderMarkdown is injection-safe — see shared/markdown.js); user text
// stays literal so what the human typed shows verbatim.
//
// why: NO keys on the returned vnodes. They get flattened into the
// parent fragment (.bubble), which also contains unkeyed siblings (muted
// streaming dot, error line). Mithril forbids mixing keyed + unkeyed
// children inside one fragment; these never reorder, so positional
// identity is fine.
/**
 * @param {string|undefined} content
 * @param {{ markdown?: boolean }} [opts]
 */
const renderText = (content, { markdown = false } = {}) => {
  if (typeof content !== 'string' || content.length === 0) return null;
  if (markdown) {
    // m.trust is safe here: renderMarkdown HTML-escapes all input and
    // only emits a fixed, known tag set.
    return m('.md', m.trust(renderMarkdown(content)));
  }
  return content.split('\n').map((line) =>
    m('div', line || m.trust('&nbsp;'))
  );
};

// ─── Tool call card ──────────────────────────────────────────────────────

/**
 * A single tool call rendered inline. Shows the §02 lineage —
 * primitive, gates, duration — by default, with the result content in
 * a collapsible <details>.
 */
/** @typedef {{ expanded: boolean }} ToolCallState */

const ToolCall = {
  /** @param {{ state: ToolCallState }} vnode */
  oninit(vnode) {
    vnode.state.expanded = false;
  },
  /**
   * @param {{
   *   attrs: {
   *     toolUse: ToolUse, toolResult: ToolResult|null,
   *     interrupted?: boolean,
   *     liveStream?: { stdout: string, stderr: string }|null,
   *     spawned?: TranscriptArgs['spawned'],
   *     actors?: Record<string, any>,
   *     scriptOps?: Record<string, any[]>,
   *     loadActor?: (sessionId: string) => void,
   *     peerName?: string, depth?: number,
   *   },
   *   state: ToolCallState,
   * }} vnode
   */
  view: ({ attrs: { toolUse, toolResult, interrupted, liveStream, spawned, actors, scriptOps, loadActor, peerName, depth }, state: ui }) => {
    // actor_create gets its own card: the expanded body is the child's
    // full transcript rendered inline (recursively), not a result blob.
    if (toolUse.name === 'actor_create') {
      return renderSpawnedCard({ toolUse, toolResult, interrupted, spawned, actors, loadActor, peerName, depth: depth ?? 0, ui });
    }
    // DESIGN-17 P1: message_actor gets the actor glass-pane card (its work
    // rendered inline from the turn/actor-* display stream).
    if (toolUse.name === 'message_actor') {
      return renderActorCard({ toolUse, toolResult, interrupted, actors, spawned, loadActor, peerName, depth: depth ?? 0, ui });
    }
    const meta = toolResult?.meta ?? null;
    // why 'cancelled': a tool_use with no result on an ABORTED turn (Stop /
    // spend-limit / steer) is NOT still running — without this it shows
    // "running…" with a pulsing dot forever, and persists that way across a
    // reload. 'cancelled' gives the card a terminal, honest resting state.
    const status = toolResult
      ? (toolResult.is_error ? 'failed' : 'ok')
      : (interrupted ? 'cancelled' : 'pending');
    const policyStatus = browserPolicyStatus(toolResult);
    const showLiveStream = toolUse.name === 'vm_boot' && !toolResult
      && liveStream && (liveStream.stdout || liveStream.stderr);
    // The live DELEGATION feed for a `script` run: one line per actors op
    // (→ target "goal…" · state). Auto-shown while pending — the user watches
    // the fan-out happen instead of a silent "running…" chip — and kept after
    // completion for a beat of continuity (the durable record is the
    // [DELEGATIONS] trace in the result body).
    const ops = toolUse.name === 'script' ? (scriptOps?.[toolUse.id] ?? null) : null;
    const showOps = ops && ops.length > 0 && (!toolResult || status === 'pending');
    // why: a single compact line is the resting state — a status dot,
    // the tool name, a one-line arg summary, and a duration. The §02
    // lineage (primitive + gates) and the full result move INTO the
    // expanded body so the collapsed chip stays small. The architecture
    // is still legible — one click away, not always on screen.
    return m(`.tool-call.tool-${status}`, [
      m('button.tool-call-header', {
        type: 'button',
        'aria-expanded': String(ui.expanded),
        onclick: () => { ui.expanded = !ui.expanded; },
      }, [
        m('span.disclosure', ui.expanded ? '▼' : '▶'),
        m(`span.tool-status-dot.dot-${status}`,
          { title: status === 'failed' ? 'failed' : status === 'pending' ? 'running' : status === 'cancelled' ? 'cancelled' : 'ok' }),
        m('span.tool-name', toolUse.name),
        m('span.tool-args', argsSummary(toolUse.input)),
        policyStatus
          ? m('span.policy-kind-chip', { title: policyStatus.title }, policyStatus.label)
          : null,
        // Failure-class chip on a failed card: the classified neighborhood
        // (policy / environment / timeout / …) at a glance; the raw error
        // stays one click away in the expanded result body.
        status === 'failed'
          ? m('span.failure-kind-chip', { title: 'failure class' },
              classifyFailure(typeof toolResult?.content === 'string' ? toolResult.content : '').kind)
          : null,
        m('.spacer'),
        status === 'pending' ? m('span.tool-pending', 'running…')
          : status === 'cancelled' ? m('span.tool-cancelled', 'cancelled')
          : meta ? m('span.tool-duration', `${meta.durationMs}ms`) : null,
      ]),
      // why: a vm_boot can take many seconds to finish (pip install,
      // unzip, the actual program). Show the streaming stdout/stderr
      // live so the user doesn't think the agent is stuck. The block
      // is auto-shown while pending; once the result lands it folds
      // into the normal expandable result body.
      showLiveStream ? m('.vm-live-stream', [
        liveStream.stdout
          ? m('pre.vm-stream-stdout', liveStream.stdout) : null,
        liveStream.stderr
          ? m('pre.vm-stream-stderr', liveStream.stderr) : null,
      ]) : null,
      showOps ? m('.script-ops', ops.map((/** @type {any} */ o) => m('.script-op', { key: o.seq }, [
        m(`span.script-op-dot.dot-${o.phase === 'sent' ? 'pending' : o.cancelled ? 'cancelled' : (o.failed ? 'failed' : 'ok')}`),
        m('span.script-op-line', [
          `${o.method}${o.to ? ` ${o.to}` : ''}`,
          o.goalPreview ? m('span.script-op-goal', ` "${o.goalPreview}"`) : null,
        ]),
        m('span.script-op-state',
          o.phase === 'sent' ? 'working…'
            : o.cancelled ? 'cancelled'
            : o.phase === 'handed-off' ? 'handed off'
            : `${o.failed ? 'failed' : 'replied'}${typeof o.ms === 'number' ? ` · ${(o.ms / 1000).toFixed(1)}s` : ''}`),
      ]))) : null,
      ui.expanded ? m('.tool-detail', [
        m('.tool-lineage', [
          m('.lineage-row', [
            m('span.lineage-label', 'primitive'),
            // Badge colored by OWNING MODULE; the module is also named in
            // full ("peerd-engine") right after, so the color is labelled,
            // not a thing the user has to decode.
            m(`span.primitive-badge.pmod-${moduleFor(meta?.primitive) ?? 'unknown'}`,
              meta?.primitive ?? '—'),
            moduleFor(meta?.primitive)
              ? m('span.primitive-module', `peerd-${moduleFor(meta?.primitive)}`)
              : null,
          ]),
          meta && meta.gates.length > 0
            ? m('.lineage-row', [
                m('span.lineage-label', 'gates'),
                m('.gate-row', meta.gates.map((g) =>
                  m(`span.gate.gate-${g.allowed ? 'pass' : 'fail'}`, {
                    title: `${g.name}: ${g.reason}`,
                    key: g.name,
                  }, [
                    m('span.gate-name', g.name),
                    m('span.gate-mark', g.allowed ? '✓' : '✗'),
                  ])
                )),
              ])
            : null,
        ]),
        m('.tool-result', [
          toolResult
            ? m('pre.tool-result-content', formatResultContent(toolResult))
            : m('p.muted', interrupted ? 'Cancelled — the turn was stopped before this tool ran.' : 'Result pending…'),
        ]),
      ]) : null,
    ]);
  },
};

// ─── Actor card ─────────────────────────────────────────────────────────
//
// An actor_create tool call renders as a disclosure whose body is the
// CHILD session's transcript, indented and rendered by the same
// renderTranscript used for the top-level chat — so a child's own
// actor_create cards expand further, recursively. Capped at
// MAX_NESTED_DEPTH visually; deeper runs are still inspectable.
/**
 * @param {{
 *   toolUse: ToolUse, toolResult: ToolResult|null, interrupted?: boolean,
 *   spawned?: TranscriptArgs['spawned'], actors?: Record<string, any>,
 *   loadActor?: (sessionId: string, retry?: boolean) => void,
 *   peerName?: string, depth: number, ui: ToolCallState,
 * }} args
 */
const renderSpawnedCard = ({ toolUse, toolResult, interrupted, spawned, actors, loadActor, peerName, depth, ui }) => {
  const meta = toolResult?.meta ?? null;
  const status = toolResult ? (toolResult.is_error ? 'failed' : 'ok') : (interrupted ? 'cancelled' : 'pending');
  const resultText = toolResult ? formatResultContent(toolResult) : '';
  const outcomeUnknown = status === 'failed' && /outcome is unknown|outcome unknown/i.test(resultText);
  const childId = resolveChildSessionId(toolUse, toolResult, spawned);
  const childSession = childId ? spawned?.sessions?.[childId] : null;
  const task = childSession?.task ?? toolUse.input?.task ?? '';
  const tooDeep = depth + 1 > MAX_NESTED_DEPTH;
  const terminalLabel = status === 'pending' ? 'running…'
    : status === 'cancelled' ? 'cancelled'
    : status === 'failed' ? (outcomeUnknown ? 'Outcome unknown' : 'failed')
    : 'done';

  const onToggle = () => {
    ui.expanded = !ui.expanded;
    // Lazy-fetch the child on first expand (e.g. after a reload, when the
    // live stream isn't in memory). loadActor dedupes.
    if (ui.expanded && childId && loadActor) loadActor(childId);
  };

  return m(`.tool-call.tool-actor.tool-${status}`, [
    m('button.tool-call-header', {
      type: 'button', onclick: onToggle, 'aria-expanded': String(ui.expanded),
    }, [
      m('span.disclosure', ui.expanded ? '▼' : '▶'),
      m(`span.tool-status-dot.dot-${status}`,
        { title: status === 'failed' ? (outcomeUnknown ? 'outcome unknown' : 'failed') : status === 'pending' ? 'running' : status === 'cancelled' ? 'cancelled' : 'ok' }),
      m('span.tool-name', 'actor_create'),
      m('span.tool-args', `"${truncate(String(task), 48)}"`),
      m('.spacer'),
      m(`span.tool-${status === 'pending' ? 'pending' : 'duration'}`, terminalLabel),
      meta ? m('span.tool-duration', `${meta.durationMs}ms`) : null,
    ]),
    ui.expanded ? m('.actor-body', [
      status === 'failed' && toolResult
        ? m('p.error-line', outcomeUnknown
          ? actorOutcomeUnknownFailure(resultText)
          : formatResultContent(toolResult))
        : null,
      tooDeep
        ? m('p.muted', `nested ${MAX_NESTED_DEPTH} levels deep — deeper transcripts are inspectable via session navigation`)
        : (childSession && Array.isArray(childSession.messages) && childSession.messages.length > 0)
          ? m('.actor-transcript',
              renderTranscript({ messages: childSession.messages, spawned, actors, loadActor, peerName, depth: depth + 1 }))
          : childSession?.loadError
            ? m('button.error-line', {
                type: 'button', onclick: () => { if (childId) loadActor?.(childId, true); },
              }, childSession.loadError)
          : childId
            ? m('p.muted', status === 'pending' ? 'actor running…' : status === 'cancelled' ? 'actor cancelled' : 'loading transcript…')
            : m('p.muted', outcomeUnknown
              ? 'No reliable actor transcript is available.'
              : 'no child transcript recorded'),
    ]) : null,
  ]);
};

// DESIGN-17 P1 glass pane: the message_actor card. The actor is a hidden,
// long-lived actor; the orchestrator only delegates to it. This renders the
// actor's work for THIS message inline (the actor live-view, for an actor)
// — driven by the turn/actor-* display stream (chat-reducer `actors`, keyed
// by this tool_use id). The tool RESULT is just the async "delivered" ack, so the
// card's live state (streaming / error / cost) — not the result — drives the chip.
/**
 * @param {{ toolUse: ToolUse, toolResult: ToolResult|null, interrupted?: boolean,
 *   actors?: Record<string, any>, spawned?: TranscriptArgs['spawned'],
 *   loadActor?: (sessionId: string) => void, peerName?: string, depth: number, ui: ToolCallState }} a
 */
const renderActorCard = ({ toolUse, toolResult, interrupted, actors, spawned, loadActor, peerName, depth, ui }) => {
  // A host-proven pre-effect terminal result never emitted actor-start. If an
  // id-keyed live card exists, it belongs to an older provider occurrence and
  // must not override this call's durable Not run result.
  const preEffectTerminal = toolResult?.actorTerminal === true
    && toolResult?.actorPerformed === false;
  const keyedCard = actors?.[toolUse.id] ?? null;
  const resultCorrelationIds = toolResult ? [
    toolResult.actorCorrelationId,
    toolResult.actorDeliveryId,
    ...(Array.isArray(toolResult.actorDeliveryIds) ? toolResult.actorDeliveryIds : []),
  ].filter((id) => typeof id === 'string') : [];
  // Actor cards remain id-keyed for compact state, but provider tool-use ids can
  // repeat across turns. Once a durable result exists, borrow the live card only
  // when host correlation proves it belongs to this exact occurrence.
  const cardMatchesResult = !toolResult || (
    typeof keyedCard?.actorCorrelationId === 'string'
    && resultCorrelationIds.includes(keyedCard.actorCorrelationId)
  );
  const card = preEffectTerminal || !cardMatchesResult ? null : keyedCard;
  const task = String(toolUse.input?.message ?? '');
  const who = card?.name ?? card?.instanceId ?? toolUse.input?.to ?? '';
  // DESIGN-18: an API actor is a web actor whose instance is an ORIGIN — label it
  // "<origin> integration" to match deliver()/ack + the prompt lore (not "web actor",
  // which wrongly implies a tab/DOM agent for a tabless fetch-only thing).
  const isApiIntegration = card?.kind === 'web' && /^https?:\/\//.test(String(who));
  const resultText = toolResult ? formatResultContent(toolResult) : '';
  const failureText = `${card?.error ?? ''} ${resultText}`;
  const outcomeUnknown = card?.outcomeKnown === false
    || (!card && toolResult?.actorOutcomeKnown === false);
  // The actor's own live state drives the status (the tool result is the async
  // "delivered" ack, not the actor outcome). No card yet → fall back to the ack.
  const status = outcomeUnknown ? 'failed'
    : card?.error ? 'failed'
    : card?.aborted ? 'cancelled'
    : card?.streaming ? 'pending'
    : card ? 'ok'
    : (toolResult ? (toolResult.actorAborted ? 'cancelled' : toolResult.is_error ? 'failed' : 'ok')
      : (interrupted ? 'cancelled' : 'pending'));
  const performed = card?.performed ?? (!card ? toolResult?.actorPerformed : undefined);
  const userFailure = performed === false ? ACTOR_NOT_RUN_USER_FAILURE : null;
  const notRun = status === 'failed' && !outcomeUnknown
    && performed === false;
  const cardLabel = preEffectTerminal
    ? 'actor'
    : isApiIntegration
      ? `${who} integration`
      : `${card?.kind ? `${card.kind} actor` : 'actor'}${who ? ` · ${who}` : ''}`;
  const presentationStatus = notRun ? 'not-run' : status;
  const handedOff = !card && toolUse.input?.await === true
    && /is still working; its reply will arrive as a fenced note on a later turn/i.test(resultText);
  const acceptedAsync = !card && !!toolResult && toolResult.is_error !== true
    && toolUse.input?.await !== true;
  const completedAwait = !card && !!toolResult && toolResult.is_error !== true
    && toolUse.input?.await === true && !handedOff;
  const terminalLabel = status === 'pending' ? 'working…'
    : status === 'cancelled' ? 'cancelled'
    : status === 'failed' ? (outcomeUnknown ? 'Outcome unknown' : notRun ? 'Not run' : 'failed')
    : handedOff ? 'handed off'
    : acceptedAsync ? 'accepted'
    : 'done';
  const tooDeep = depth + 1 > MAX_NESTED_DEPTH;
  const onToggle = () => { ui.expanded = !ui.expanded; };
  return m(`.tool-call.tool-actor.tool-${presentationStatus}`, [
    m('button.tool-call-header', {
      type: 'button', onclick: onToggle, 'aria-expanded': String(ui.expanded),
    }, [
      m('span.disclosure', ui.expanded ? '▼' : '▶'),
      m(`span.tool-status-dot.dot-${presentationStatus}`,
        presentationStatus === 'not-run'
          ? { 'aria-hidden': 'true' }
          : { title: status === 'failed' ? (outcomeUnknown ? 'outcome unknown' : 'failed') : status === 'pending' ? 'working' : status === 'cancelled' ? 'cancelled' : 'ok' }),
      m('span.tool-name', 'message_actor'),
      m('span.tool-args', `${cardLabel}: "${truncate(task, 40)}"`),
      m('.spacer'),
      m(`span.tool-${status === 'pending' ? 'pending' : 'duration'}`, terminalLabel),
      // Spend stays separate so the terminal state is visible even at $0.00.
      card?.cost ? m('span.tool-duration', { title: 'this actor turn’s spend' }, `$${Number(card.cost.cost ?? 0).toFixed((card.cost.cost ?? 0) < 0.01 ? 4 : 2)}`) : null,
    ]),
    ui.expanded ? m('.actor-body', [
      card?.error
        ? m('p.error-line', outcomeUnknown
          ? actorOutcomeUnknownFailure(String(card.error))
          : (userFailure ?? String(card.error)))
        : null,
      !card?.error && toolResult?.is_error
        ? m('p.error-line', outcomeUnknown
          ? actorOutcomeUnknownFailure(resultText)
          : (userFailure ?? resultText))
        : null,
      card?.error || toolResult?.is_error
        ? null
        : tooDeep
        ? m('p.muted', `nested ${MAX_NESTED_DEPTH} levels deep — deeper transcripts are inspectable via session navigation`)
        : (card && Array.isArray(card.messages) && card.messages.length > 0)
          ? m('.actor-transcript',
              renderTranscript({ messages: card.messages, actors, spawned, loadActor, peerName, depth: depth + 1 }))
          : completedAwait
            ? m('pre.tool-result-content', resultText)
          : handedOff
            ? m('p.muted', 'the actor is still working; check later messages for the reply')
          : m('p.muted', card?.streaming ? 'actor working…'
              // Historical success proves acceptance, not delivery. A reload may
              // have lost the live card while the reply is still pending.
              : (!card && toolResult && !toolResult.is_error) ? 'request accepted; check later messages for the reply'
              : 'no actor activity yet — its reply will arrive on a later turn'),
    ]) : null,
  ]);
};

// Find the child session id for an actor_create card. The live map
// (populated by turn/spawned-start during this panel's lifetime) is
// authoritative; after a reload we fall back to parsing the id out of
// the tool result's formatted header ("actor (session <id>, ...").
/**
 * @param {ToolUse} toolUse
 * @param {ToolResult|null} toolResult
 * @param {TranscriptArgs['spawned']} spawned
 * @returns {string|null}
 */
const resolveChildSessionId = (toolUse, toolResult, spawned) => {
  const live = spawned?.byToolUse?.[toolUse.id];
  if (live) return live;
  const content = toolResult?.content;
  if (typeof content === 'string') {
    const match = content.match(/session (\S+?),/);
    if (match) return match[1];
  }
  return null;
};

/**
 * Compact one-line summary of tool inputs for the collapsed header.
 * `{prefix: "vault"}` → `prefix="vault"`.
 * @param {Record<string, unknown>|undefined} input
 */
const argsSummary = (input) => {
  if (!input || typeof input !== 'object') return '()';
  const entries = Object.entries(input);
  if (entries.length === 0) return '()';
  return `(${  entries.map(([k, v]) => {
    let val;
    if (typeof v === 'string') val = `"${truncate(v, 24)}"`;
    else if (Array.isArray(v)) val = `[${v.length}]`;
    else if (v && typeof v === 'object') val = '{…}';
    else val = String(v);
    return `${k}=${val}`;
  }).join(', ')  })`;
};

/**
 * @param {string} s
 * @param {number} n
 */
const truncate = (s, n) => s.length <= n ? s : `${s.slice(0, n - 1)}…`;

/** @param {ToolResult|null} toolResult */
const browserPolicyStatus = (toolResult) => {
  if (!toolResult) return null;
  const notices = (toolResult.meta?.browserPolicies ?? []).filter((notice) =>
    notice && typeof notice === 'object'
    && ['protected_child_navigation', 'protected_child_request', 'child_navigation_failed', 'child_navigation_unverified']
      .includes(notice.reason)
    && ['not_run', 'unverified'].includes(notice.outcome)
    && ['closed', 'left_blank', 'guarded', 'uncontained'].includes(notice.child)
    && notice.retryable === false);
  if (notices.length === 0) return null;
  if (notices.some((/** @type {{ child?: string }} */ notice) => notice?.child === 'uncontained')) {
    return {
      label: 'child control not confirmed',
      title: 'The browser did not confirm that the child tab was closed or blank',
    };
  }
  const blocked = notices.filter(
    (/** @type {{ outcome?: string }} */ notice) => notice?.outcome === 'not_run',
  ).length;
  return {
    label: notices.length > 1 ? `${notices.length} child actions stopped` : 'child action stopped',
    title: blocked === notices.length
      ? 'A protected child action did not run'
      : 'A child navigation could not be verified',
  };
};

/** @param {ToolResult} toolResult */
const formatResultContent = (toolResult) => {
  let content = toolResult.content;
  // Tool results are JSON strings in V1. Try to pretty-print, fall
  // back to the raw string if it isn't JSON.
  try {
    if (typeof content === 'string' && content.length > 0) {
      const parsed = JSON.parse(content);
      content = JSON.stringify(parsed, null, 2);
    }
  } catch { /* leave as-is */ }
  // Display-only: hide the <untrusted_*> fence WRAPPER tags from the rendered
  // card (web actor page reads + fetch_url, at every nested transcript depth) —
  // the body stays, the model still receives the fence in the persisted
  // tool_result. The single chokepoint for every tool-result card.
  return stripUntrustedFences(content);
};

// Canonical primitive → owning peerd module. This is the SINGLE source
// of truth: the badge color (CSS .pmod-<module>) and the "peerd-<module>"
// label both derive from it, so color and text can never drift. Mapping
// is by which module actually owns the subsystem the primitive exercises
// (see CLAUDE.md's five-module table), NOT by aesthetic color choice:
//
//   egress  (red)     inspect — reads vault/denylist/audit
//                     web     — outbound HTTP through safeFetch/webFetch
//   runtime (green)   tab     — DOM/page/tab driving
//                     time    — clock / temporal grounding
//                     actor— agent-loop orchestration (docs/ACTORS.md)
//   engine  (amber)   webvm    — WebVM execution kind
//                     notebook — Notebook execution kind
//                     pod     : Pod execution kind
//                     app      — App execution kind
//   distributed       dweb     — the dweb / dwapp network (share/discover/
//   (magenta)                    install/peers/block/discovery/guide)
//
// provider (cyan) owns no tool primitive — the model call isn't a tool. The
// dweb tools are preview-only (exposure-gated), so the distributed badge only
// appears on preview builds; that's honest, not a gap.
/** @type {Readonly<Record<string, string>>} */
const PRIMITIVE_MODULE = Object.freeze({
  inspect:  'egress',
  web:      'egress',
  tab:      'runtime',
  time:     'runtime',
  actor: 'runtime',
  webvm:    'engine',
  notebook: 'engine',
  pod:      'engine',
  app:      'engine',
  engine:   'engine',
  dweb:     'distributed',
});

// Returns the owning module for a primitive, or null if unknown/unmapped.
/** @param {string|undefined} p */
const moduleFor = (p) =>
  (typeof p === 'string' && PRIMITIVE_MODULE[p.toLowerCase()]) || null;
