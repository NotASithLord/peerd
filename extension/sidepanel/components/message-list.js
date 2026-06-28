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
import { formatBytes } from '/peerd-runtime/index.js';

/** @typedef {import('../chat-reducer.js').ChatMessage} ChatMessage */
/** @typedef {import('../chat-reducer.js').SubagentSession} SubagentSession */

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
 * @property {{ primitive?: string, durationMs?: number, dispatch?: string, gates: Array<{ name: string, reason: string, allowed: boolean }> }|null} [meta]
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
 * @property {string|null} [turnId]
 */

/**
 * Args shared by the recursive transcript renderer.
 * @typedef {Object} TranscriptArgs
 * @property {ChatMessage[]} [messages]
 * @property {Record<string, { stdout: string, stderr: string }>} [vmStreams]
 * @property {{ byToolUse?: Record<string, string>, sessions?: Record<string, SubagentSession> }} [subagents]
 * @property {Record<string, any>} [actors]
 * @property {(sessionId: string) => void} [loadSubagent]
 * @property {string} [peerName]
 * @property {number} [depth]
 * @property {TabEvent[]} [tabEvents]
 * @property {UiActions} [uiActions]
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

// How many levels of nested subagent transcript to render inline before
// stopping. Deeper runs still exist and are inspectable, but rendering
// them inline would explode the layout.
const MAX_NESTED_DEPTH = 5;

// Render one transcript (a flat message array) as keyed user/assistant
// rows. Shared between the top-level chat and every nested subagent
// transcript — a spawn_subagent card renders its child by calling this
// again at depth+1, so the structure is naturally recursive.
/**
 * @param {TranscriptArgs} args
 * @returns {any[]}
 */
const renderTranscript = ({ messages, vmStreams, subagents, actors, loadSubagent, peerName, depth = 0, tabEvents = [], uiActions }) => {
  const groups = groupMessages(messages ?? []);
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
    // muted, pinned just above this user message).
    if (g.type === 'user') { flush(curTurn, false); curTurn = g.message.id; }
    out.push(g.type === 'user'
      ? m(UserMessage, { key: g.message.id, message: g.message })
      : m(AssistantMessage, {
          key: g.message.id, message: g.message, toolResults: g.toolResults,
          vmStreams, subagents, actors, loadSubagent, peerName, depth,
        }));
  });
  // The current (last) turn's notices render at the very end — fresh; any with an
  // unmatched turn (e.g. opened before the first user message) trail after.
  if (depth === 0) {
    flush(curTurn, true);
    for (const ev of tabEvents) flush(ev.turnId, true);
  }
  return out;
};

export const MessageList = {
  // Initial mount: jump to the bottom so existing-session render starts
  // with the latest turn visible, not the first message.
  /** @param {{ dom: HTMLElement }} vnode */
  oncreate(vnode) { vnode.dom.scrollTop = vnode.dom.scrollHeight; },
  /** @param {{ dom: HTMLElement }} vnode */
  onupdate(vnode) { scrollIfNearBottom(vnode.dom); },

  /** @param {{ attrs: TranscriptArgs }} vnode */
  view: ({ attrs: { messages, vmStreams, subagents, actors, loadSubagent, peerName, tabEvents, uiActions } }) =>
    m('.message-list',
      renderTranscript({ messages, vmStreams, subagents, actors, loadSubagent, peerName, depth: 0, tabEvents, uiActions })),
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
    return m(`.agent-tab-notice${fresh ? '.agent-tab-notice--fresh' : ''}`, [
      m('span.agent-tab-notice-icon', { 'aria-hidden': 'true' }, '▦'),
      m('span.agent-tab-notice-text', ['peerd opened ', m('span.agent-tab-notice-label', label)]),
      m('button.agent-tab-notice-go', {
        type: 'button',
        title: 'Go to this tab',
        onclick: () => uiActions?.openAgentTab?.(ev.tabId, ev.windowId),
      }, 'Go ↗'),
    ]);
  },
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
 * @returns {Array<{ type: 'user', message: ChatMessage } | { type: 'assistant', message: ChatMessage, toolResults: PairedTool[] }>}
 */
const groupMessages = (messages) => {
  /** @type {Array<{ type: 'user', message: ChatMessage } | { type: 'assistant', message: ChatMessage, toolResults: PairedTool[] }>} */
  const out = [];
  /** @type {Map<string, ToolResult>} */
  const resultsByToolUseId = new Map();
  // First pass: collect tool results into a flat map.
  // why `msg` not `m`: `m` is the Mithril alias imported at module top;
  // reusing it as a loop var shadows it (matches the `msg` loop below).
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.toolResults)) {
      for (const tr of /** @type {ToolResult[]} */ (msg.toolResults)) {
        if (tr?.tool_use_id) resultsByToolUseId.set(tr.tool_use_id, tr);
      }
    }
  }
  for (const msg of messages) {
    if (msg.role === 'user') {
      const isToolResultOnly = (!msg.content || msg.content === '')
        && Array.isArray(msg.toolResults) && msg.toolResults.length > 0;
      if (isToolResultOnly) continue; // pair with prior assistant via map
      // Synthetic continuation nudges (agent-loop truncation recovery)
      // are loop plumbing, not something the user typed — the truncated
      // assistant message's stop-reason chip tells the visible story.
      if (msg.synthetic) continue;
      out.push({ type: 'user', message: msg });
    } else if (msg.role === 'assistant') {
      const toolUses = Array.isArray(msg.toolUses) ? /** @type {ToolUse[]} */ (msg.toolUses) : [];
      const paired = toolUses.map((tu) => ({
        toolUse: tu,
        toolResult: resultsByToolUseId.get(tu.id) ?? null,
      }));
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

const AssistantMessage = {
  /**
   * @param {{ attrs: {
   *   message: ChatMessage, toolResults: PairedTool[],
   *   vmStreams?: Record<string, { stdout: string, stderr: string }>,
   *   subagents?: TranscriptArgs['subagents'],
   *   actors?: Record<string, any>,
   *   loadSubagent?: (sessionId: string) => void,
   *   peerName?: string, depth?: number,
   * } }} vnode
   */
  view: ({ attrs: { message, toolResults, vmStreams, subagents, actors, loadSubagent, peerName, depth } }) => {
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
              subagents,
              actors,
              loadSubagent,
              peerName,
              depth: depth ?? 0,
            })
          ))
        : null,
    ]);
  },
};

// ─── Thinking spinner ────────────────────────────────────────────────────
//
// The peerd beachball: a classic-Mac rainbow wheel where the five brand
// colors meld into each other in one conic gradient (see .peerd-spinner
// in styles.css). A single div — the gradient and spin are CSS-only and
// disabled under prefers-reduced-motion.
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
   *     subagents?: TranscriptArgs['subagents'],
   *     actors?: Record<string, any>,
   *     loadSubagent?: (sessionId: string) => void,
   *     peerName?: string, depth?: number,
   *   },
   *   state: ToolCallState,
   * }} vnode
   */
  view: ({ attrs: { toolUse, toolResult, interrupted, liveStream, subagents, actors, loadSubagent, peerName, depth }, state: ui }) => {
    // spawn_subagent gets its own card: the expanded body is the child's
    // full transcript rendered inline (recursively), not a result blob.
    if (toolUse.name === 'spawn_subagent') {
      return renderSubagentCard({ toolUse, toolResult, interrupted, subagents, actors, loadSubagent, peerName, depth: depth ?? 0, ui });
    }
    // DESIGN-17 P1: message_actor gets the actor glass-pane card (its work
    // rendered inline from the turn/actor-* display stream).
    if (toolUse.name === 'message_actor') {
      return renderActorCard({ toolUse, toolResult, interrupted, actors, subagents, loadSubagent, peerName, depth: depth ?? 0, ui });
    }
    const meta = toolResult?.meta ?? null;
    // why 'cancelled': a tool_use with no result on an ABORTED turn (Stop /
    // spend-limit / steer) is NOT still running — without this it shows
    // "running…" with a pulsing dot forever, and persists that way across a
    // reload. 'cancelled' gives the card a terminal, honest resting state.
    const status = toolResult
      ? (toolResult.is_error ? 'failed' : 'ok')
      : (interrupted ? 'cancelled' : 'pending');
    const showLiveStream = toolUse.name === 'vm_boot' && !toolResult
      && liveStream && (liveStream.stdout || liveStream.stderr);
    // why: a single compact line is the resting state — a status dot,
    // the tool name, a one-line arg summary, and a duration. The §02
    // lineage (primitive + gates) and the full result move INTO the
    // expanded body so the collapsed chip stays small. The architecture
    // is still legible — one click away, not always on screen.
    return m(`.tool-call.tool-${status}`, [
      m('.tool-call-header', {
        onclick: () => { ui.expanded = !ui.expanded; },
      }, [
        m('span.disclosure', ui.expanded ? '▼' : '▶'),
        m(`span.tool-status-dot.dot-${status}`,
          { title: status === 'failed' ? 'failed' : status === 'pending' ? 'running' : status === 'cancelled' ? 'cancelled' : 'ok' }),
        m('span.tool-name', toolUse.name),
        m('span.tool-args', argsSummary(toolUse.input)),
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
            // dispatch: how the action was carried out (orthogonal to the
            // resource primitive). 'runner' = a spawned browser-runner drove
            // the tab — the trigger, surfaced so it's not hidden in the nested
            // transcript below.
            meta?.dispatch === 'runner'
              ? m('span.dispatch-badge', 'via runner')
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

// ─── Subagent card ─────────────────────────────────────────────────────────
//
// A spawn_subagent tool call renders as a disclosure whose body is the
// CHILD session's transcript, indented and rendered by the same
// renderTranscript used for the top-level chat — so a child's own
// spawn_subagent cards expand further, recursively. Capped at
// MAX_NESTED_DEPTH visually; deeper runs are still inspectable.
/**
 * @param {{
 *   toolUse: ToolUse, toolResult: ToolResult|null, interrupted?: boolean,
 *   subagents?: TranscriptArgs['subagents'], actors?: Record<string, any>,
 *   loadSubagent?: (sessionId: string) => void,
 *   peerName?: string, depth: number, ui: ToolCallState,
 * }} args
 */
const renderSubagentCard = ({ toolUse, toolResult, interrupted, subagents, actors, loadSubagent, peerName, depth, ui }) => {
  const meta = toolResult?.meta ?? null;
  const status = toolResult ? (toolResult.is_error ? 'failed' : 'ok') : (interrupted ? 'cancelled' : 'pending');
  const childId = resolveChildSessionId(toolUse, toolResult, subagents);
  const childSession = childId ? subagents?.sessions?.[childId] : null;
  const task = childSession?.task ?? toolUse.input?.task ?? '';
  const tooDeep = depth + 1 > MAX_NESTED_DEPTH;

  const onToggle = () => {
    ui.expanded = !ui.expanded;
    // Lazy-fetch the child on first expand (e.g. after a reload, when the
    // live stream isn't in memory). loadSubagent dedupes.
    if (ui.expanded && childId && loadSubagent) loadSubagent(childId);
  };

  return m(`.tool-call.tool-subagent.tool-${status}`, [
    m('.tool-call-header', { onclick: onToggle }, [
      m('span.disclosure', ui.expanded ? '▼' : '▶'),
      m(`span.tool-status-dot.dot-${status}`,
        { title: status === 'failed' ? 'failed' : status === 'pending' ? 'running' : status === 'cancelled' ? 'cancelled' : 'ok' }),
      m('span.tool-name', 'spawn_subagent'),
      m('span.tool-args', `"${truncate(String(task), 48)}"`),
      m('.spacer'),
      status === 'pending' ? m('span.tool-pending', 'running…')
        : status === 'cancelled' ? m('span.tool-cancelled', 'cancelled')
        : meta ? m('span.tool-duration', `${meta.durationMs}ms`) : null,
    ]),
    ui.expanded ? m('.subagent-body', [
      status === 'failed' && toolResult
        ? m('p.error-line', formatResultContent(toolResult))
        : null,
      tooDeep
        ? m('p.muted', `nested ${MAX_NESTED_DEPTH} levels deep — deeper transcripts are inspectable via session navigation`)
        : (childSession && childSession.messages.length > 0)
          ? m('.subagent-transcript',
              renderTranscript({ messages: childSession.messages, subagents, actors, loadSubagent, peerName, depth: depth + 1 }))
          : childId
            ? m('p.muted', status === 'pending' ? 'subagent running…' : status === 'cancelled' ? 'subagent cancelled' : 'loading transcript…')
            : m('p.muted', 'no child transcript recorded'),
    ]) : null,
  ]);
};

// DESIGN-17 P1 glass pane: the message_actor card. The actor is a hidden,
// long-lived actor; the orchestrator only delegates to it. This renders the
// actor's work for THIS message inline (the subagent live-view, for an actor)
// — driven by the turn/actor-* display stream (chat-reducer `actors`, keyed
// by this tool_use id). The tool RESULT is just the async "delivered" ack, so the
// card's live state (streaming / error / cost) — not the result — drives the chip.
/**
 * @param {{ toolUse: ToolUse, toolResult: ToolResult|null, interrupted?: boolean,
 *   actors?: Record<string, any>, subagents?: TranscriptArgs['subagents'],
 *   loadSubagent?: (sessionId: string) => void, peerName?: string, depth: number, ui: ToolCallState }} a
 */
const renderActorCard = ({ toolUse, toolResult, interrupted, actors, subagents, loadSubagent, peerName, depth, ui }) => {
  const card = actors?.[toolUse.id] ?? null;
  const task = String(toolUse.input?.message ?? '');
  const kindLabel = card?.kind ? `${card.kind} actor` : 'actor';
  const who = card?.name ?? card?.instanceId ?? toolUse.input?.to ?? '';
  // The actor's own live state drives the status (the tool result is the async
  // "delivered" ack, not the actor outcome). No card yet → fall back to the ack.
  const status = card?.error ? 'failed'
    : card?.aborted ? 'cancelled'
    : card?.streaming ? 'pending'
    : card ? 'ok'
    : (toolResult ? (toolResult.is_error ? 'failed' : 'ok') : (interrupted ? 'cancelled' : 'pending'));
  const tooDeep = depth + 1 > MAX_NESTED_DEPTH;
  const onToggle = () => { ui.expanded = !ui.expanded; };
  return m(`.tool-call.tool-actor.tool-${status}`, [
    m('.tool-call-header', { onclick: onToggle }, [
      m('span.disclosure', ui.expanded ? '▼' : '▶'),
      m(`span.tool-status-dot.dot-${status}`,
        { title: status === 'failed' ? 'failed' : status === 'pending' ? 'working' : status === 'cancelled' ? 'cancelled' : 'ok' }),
      m('span.tool-name', 'message_actor'),
      m('span.tool-args', `${kindLabel}${who ? ` · ${who}` : ''}: "${truncate(task, 40)}"`),
      m('.spacer'),
      status === 'pending' ? m('span.tool-pending', 'working…')
        // Show the spend chip whenever a tally is present — incl. $0.00 for a
        // keyless/Ollama turn — so a completed card always carries a terminal chip.
        : card?.cost ? m('span.tool-duration', { title: 'this actor turn’s spend' }, `$${Number(card.cost.cost ?? 0).toFixed((card.cost.cost ?? 0) < 0.01 ? 4 : 2)}`)
        : null,
    ]),
    ui.expanded ? m('.subagent-body', [
      card?.error ? m('p.error-line', String(card.error)) : null,
      tooDeep
        ? m('p.muted', `nested ${MAX_NESTED_DEPTH} levels deep — deeper transcripts are inspectable via session navigation`)
        : (card && Array.isArray(card.messages) && card.messages.length > 0)
          ? m('.subagent-transcript',
              renderTranscript({ messages: card.messages, actors, subagents, loadSubagent, peerName, depth: depth + 1 }))
          : m('p.muted', card?.streaming ? 'actor working…'
              // No card after a non-error "delivered" ack = the reply already landed
              // on a later turn (the live stream was lost to a reload / SW restart).
              : (!card && toolResult && !toolResult.is_error) ? 'reply delivered on a later turn'
              : 'no actor activity yet — its reply will arrive on a later turn'),
    ]) : null,
  ]);
};

// Find the child session id for a spawn_subagent card. The live map
// (populated by turn/subagent-start during this panel's lifetime) is
// authoritative; after a reload we fall back to parsing the id out of
// the tool result's formatted header ("subagent (session <id>, ...").
/**
 * @param {ToolUse} toolUse
 * @param {ToolResult|null} toolResult
 * @param {TranscriptArgs['subagents']} subagents
 * @returns {string|null}
 */
const resolveChildSessionId = (toolUse, toolResult, subagents) => {
  const live = subagents?.byToolUse?.[toolUse.id];
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
  // card (do/get/check runner summaries + fetch_url, at every nested
  // transcript depth) — the body stays, the model still receives the fence in
  // the persisted tool_result. The single chokepoint for every tool-result card.
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
//                     subagent— agent-loop orchestration
//   engine  (amber)   webvm    — WebVM execution kind
//                     notebook — Notebook execution kind
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
  subagent: 'runtime',
  webvm:    'engine',
  notebook: 'engine',
  app:      'engine',
  dweb:     'distributed',
});

// Returns the owning module for a primitive, or null if unknown/unmapped.
/** @param {string|undefined} p */
const moduleFor = (p) =>
  (typeof p === 'string' && PRIMITIVE_MODULE[p.toLowerCase()]) || null;
