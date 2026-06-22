// @ts-check
// Internal message shape → Anthropic /v1/messages request body.
//
// V1 messages can be:
//   - plain user text
//   - plain assistant text
//   - assistant text + tool_use blocks   (mixed-content)
//   - user tool_result blocks            (no text)
//
// Anthropic accepts string content for the simple cases and an array of
// content blocks for the mixed/tool cases. We emit string content when
// we can (no tool fields, simple text) and blocks otherwise — keeps the
// request payload small and human-readable in dev logs.

/** @typedef {import('../types.js').InternalMessage} InternalMessage */
/** @typedef {import('../types.js').AssistantMessage} AssistantMessage */
/** @typedef {import('../types.js').ToolUseBlock} ToolUseBlock */
/** @typedef {import('../types.js').ToolResultBlock} ToolResultBlock */
/** @typedef {import('../types.js').Attachment} Attachment */

/**
 * One Anthropic content block. The block kinds peerd emits differ by `type`
 * (text / image / document / tool_use / tool_result / thinking); the optional
 * fields below cover every kind so the converter and the orphan-repair walk
 * can read `type` / `id` / `tool_use_id` off a block without a per-kind cast.
 * `cache_control` is attached to the last block of the prompt for caching.
 * @typedef {Object} AnthropicBlock
 * @property {string} type
 * @property {string} [text]
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [tool_use_id]
 * @property {unknown} [input]
 * @property {string | AnthropicBlock[]} [content]
 * @property {boolean} [is_error]
 * @property {object} [source]
 * @property {string} [thinking]
 * @property {string} [signature]
 * @property {string} [data]
 * @property {{ type: 'ephemeral' }} [cache_control]
 */

/**
 * One Anthropic /v1/messages wire message.
 * @typedef {{ role: 'user' | 'assistant', content: string | AnthropicBlock[] }} AnthropicMessage
 */

// User-attached files (feature: file upload). A user message carrying
// LIVE attachments (base64 present, not stripped) renders as a content
// ARRAY — image/document blocks FIRST, then the text block (the order
// Anthropic recommends for vision prompts). Stripped attachments
// (send-once-then-strip — see peerd-runtime/loop/attachments.js) leave
// a one-line metadata sentinel in the text instead, mirroring how
// redact.js marks stripped screenshots: the model keeps a durable trace
// of WHAT was attached without the bytes ever re-shipping. text-kind
// attachments produce neither — their payload was inlined into the
// message text at send time and persists there.
/**
 * @param {Attachment} a
 * @returns {AnthropicBlock | null}
 */
const attachmentBlock = (a) => {
  if (a.kind === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } };
  }
  if (a.kind === 'pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } };
  }
  return null;
};

/** @param {Attachment} a */
const isLiveBlockAttachment = (a) =>
  !a?.stripped && typeof a?.data === 'string' && a.data.length > 0
  && (a.kind === 'image' || a.kind === 'pdf');

/** @param {Attachment} a */
const strippedSentinel = (a) =>
  `<attachment name="${String(a.name ?? 'file').replace(/[<>"]/g, '')}" `
  + `media_type="${a.mediaType}" ${a.size}B stripped — sent on its original turn>`;

/**
 * Map a single internal message to its Anthropic wire shape.
 *
 * @param {InternalMessage} m
 * @param {boolean} [thinkingEnabled]
 *   When true AND the assistant message carries persisted thinking
 *   blocks, replay them (with their signatures) at the head of the
 *   content array. Anthropic REQUIRES this: a tool_use turn produced
 *   under extended thinking must echo the preceding thinking block back
 *   on the next request or the API 400s. When false we strip thinking
 *   blocks entirely — sending a thinking block while thinking is
 *   disabled is itself a 400, so the flag has to gate both directions.
 * @returns {AnthropicMessage | null}
 */
const toAnthropicMessage = (m, thinkingEnabled = false) => {
  if (m.role !== 'user' && m.role !== 'assistant') return null;

  if (m.role === 'assistant') {
    /** @type {AnthropicBlock[]} */
    const blocks = [];
    // Thinking blocks come FIRST — the API is order-sensitive (the
    // signed thinking block must precede the text/tool_use it produced).
    if (thinkingEnabled && Array.isArray(m.thinkingBlocks)) {
      for (const tb of m.thinkingBlocks) {
        if (tb?.type === 'redacted_thinking' && typeof tb.data === 'string') {
          blocks.push({ type: 'redacted_thinking', data: tb.data });
        } else if (typeof tb?.thinking === 'string' && typeof tb?.signature === 'string' && tb.signature) {
          // why: a signature-less thinking block can't be replayed (the
          // API rejects it); drop those rather than poison the request.
          blocks.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature });
        }
      }
    }
    const headThinking = blocks.length;
    if (typeof m.content === 'string' && m.content.length > 0) {
      blocks.push({ type: 'text', text: m.content });
    }
    if (Array.isArray(m.toolUses) && m.toolUses.length > 0) {
      for (const tu of m.toolUses) {
        blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input ?? {} });
      }
    }
    // Optimization: pure text → string content (only when no thinking
    // blocks rode along — those force the array shape).
    if (headThinking === 0 && blocks.length === 1 && blocks[0].type === 'text') {
      return { role: 'assistant', content: m.content };
    }
    // Empty (or thinking-only) assistant message is invalid for
    // Anthropic — thinking must lead into real text/tool_use content.
    // Drop it; happens if a previous assistant produced only tool_use
    // blocks that were filtered, or if streaming aborted early.
    if (blocks.length === headThinking) {
      return null;
    }
    return { role: 'assistant', content: blocks };
  }

  // user
  if (Array.isArray(m.toolResults) && m.toolResults.length > 0) {
    return {
      role: 'user',
      content: m.toolResults.map((tr) => ({
        type: 'tool_result',
        tool_use_id: tr.tool_use_id,
        content: tr.content,
        ...(tr.is_error ? { is_error: true } : {}),
      })),
    };
  }
  if (typeof m.content !== 'string') return null;
  const attachments = Array.isArray(m.attachments) ? m.attachments : [];
  if (attachments.length > 0) {
    // Stripped image/pdf records collapse to sentinel lines ahead of the
    // user's text — cheap (one line each, ≤5), durable across re-sends.
    const sentinels = attachments
      .filter((a) => a?.stripped && (a.kind === 'image' || a.kind === 'pdf'))
      .map(strippedSentinel);
    const text = [...sentinels, ...(m.content.length > 0 ? [m.content] : [])].join('\n');
    // isLiveBlockAttachment guarantees image/pdf, so attachmentBlock never
    // returns null here; the predicate filter drops the (impossible) nulls
    // for the type-checker without altering runtime behaviour.
    const blocks = attachments
      .filter(isLiveBlockAttachment)
      .map(attachmentBlock)
      .filter(/** @returns {b is AnthropicBlock} */ (b) => b !== null);
    if (blocks.length > 0) {
      // Blocks FIRST, then the text block. An empty text never emits a
      // block — the API rejects empty text blocks.
      return {
        role: 'user',
        content: text.length > 0 ? [...blocks, { type: 'text', text }] : blocks,
      };
    }
    // No live blocks (all stripped, or text-kind only) → plain string,
    // keeping the same-role collapse + small-payload path intact.
    return { role: 'user', content: text.length > 0 ? text : m.content };
  }
  return { role: 'user', content: m.content };
};

/**
 * @param {readonly InternalMessage[]} messages
 * @param {boolean} [thinkingEnabled]   replay persisted thinking blocks
 * @returns {AnthropicMessage[]}
 */
export const toAnthropicMessages = (messages, thinkingEnabled = false) => {
  /** @type {AnthropicMessage[]} */
  const out = [];
  for (const m of messages) {
    const converted = toAnthropicMessage(m, thinkingEnabled);
    if (!converted) continue;
    // Collapse adjacent same-role messages only when both are plain
    // string content. tool_use / tool_result blocks must stay as
    // distinct messages — the API tracks them by position.
    const prev = out[out.length - 1];
    if (
      prev?.role === converted.role
      && typeof prev.content === 'string'
      && typeof converted.content === 'string'
    ) {
      prev.content = `${prev.content}\n\n${converted.content}`;
    } else {
      out.push(converted);
    }
  }
  // Build a tool_use_id → cause lookup from the originals so the orphan
  // repair can emit a cause-aware synth tool_result instead of a generic
  // "interrupted turn" string. The cause comes from the owning assistant
  // message's stopReason + error.
  /** @type {Map<string, string>} */
  const causeByToolUseId = new Map();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.toolUses)) continue;
    const cause = explainStopCause(m);
    for (const tu of m.toolUses) {
      if (typeof tu.id === 'string') causeByToolUseId.set(tu.id, cause);
    }
  }
  return repairOrphanToolUses(out, causeByToolUseId);
};

/**
 * Map a session's persisted assistant-message metadata to a
 * short string the next-turn model can read and react to.
 * @param {AssistantMessage} m
 * @returns {string}
 */
const explainStopCause = (m) => {
  if (m.stopReason === 'aborted') {
    return 'interrupted by user (new message sent or Stop clicked)';
  }
  if (m.stopReason === 'incomplete') {
    return 'provider stream ended early (likely rate limit or network drop). Safe to retry after a brief wait.';
  }
  if (m.stopReason === 'max_tokens') {
    return 'provider hit max_tokens before tool dispatch. Retry with a smaller request (split work across multiple tool calls).';
  }
  if (m.error) {
    const excerpt = String(m.error).slice(0, 200);
    return `provider error before dispatch: ${excerpt}`;
  }
  return 'tool dispatch did not complete';
};

/**
 * Anthropic requires every `tool_use` block to be IMMEDIATELY followed by
 * a user message containing matching `tool_result` blocks (one per
 * tool_use_id). If a turn ended mid-dispatch — SW restart, error before
 * persistence, abort — the session can end up with an assistant message
 * whose tool_use blocks have no paired results. The next /v1/messages
 * call then 400s with: "tool_use ids were found without tool_result
 * blocks immediately after".
 *
 * This is a wire-format-only repair: we don't mutate the persisted
 * session. We walk the converted messages, detect orphan tool_use
 * blocks, and synthesize an `is_error: true` tool_result for each so
 * the prompt structure is valid. If we synthesize a user message that
 * collides with one already at that position, we merge into it.
 *
 * @param {AnthropicMessage[]} msgs
 * @param {Map<string, string>} [causeByToolUseId]
 * @returns {AnthropicMessage[]}
 */
const repairOrphanToolUses = (msgs, causeByToolUseId = new Map()) => {
  /** @type {AnthropicMessage[]} */
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    out.push(m);
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    // flatMap (not filter+map) so the result is typed string[] — the empty
    // array yielded for a non-tool_use / id-less block drops it, same as the
    // old filter, while narrowing id from `string | undefined` to `string`.
    const toolUseIds = m.content.flatMap((b) =>
      b?.type === 'tool_use' && typeof b.id === 'string' ? [b.id] : []);
    if (toolUseIds.length === 0) continue;

    const next = msgs[i + 1];
    const nextResults = (next?.role === 'user' && Array.isArray(next.content))
      ? next.content.filter((b) => b?.type === 'tool_result')
      : [];
    const present = new Set(nextResults.map((b) => b.tool_use_id));
    const orphanIds = toolUseIds.filter((id) => !present.has(id));
    if (orphanIds.length === 0) continue;

    /** @type {AnthropicBlock[]} */
    const repairBlocks = orphanIds.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: causeByToolUseId.get(id)
        ?? 'tool dispatch did not complete. Treat as failed and retry if needed.',
      is_error: true,
    }));

    // why: if there's already a user message in the next position,
    // prepend the synthetic results to its content array (preserving
    // any real results that DID make it through). Otherwise insert a
    // new user message between us and whatever comes next.
    if (next?.role === 'user' && Array.isArray(next.content)) {
      next.content = [...repairBlocks, ...next.content];
    } else {
      out.push({ role: 'user', content: repairBlocks });
    }
  }
  return out;
};

/**
 * Decide which thinking request shape a model takes.
 *
 * why: Anthropic split the `thinking` param by model generation. The
 * 4.6-era and newer models (Opus 4.6/4.7/4.8, Sonnet 4.6, Fable 5)
 * accept ONLY the adaptive shape — sending the legacy
 * `{ type: 'enabled', budget_tokens }` form returns HTTP 400 on Opus
 * 4.7+ and is deprecated on 4.6 (per the platform migration guide:
 * "thinking: {type: 'enabled', budget_tokens: N} returns a 400 —
 * adaptive is the only on-mode"). Pre-4.6 models (Haiku 4.5, Sonnet
 * 4.5, Opus 4.5/4.1, the claude-3-* line) never learned the adaptive
 * shape and still require enabled+budget.
 *
 * Keyed off the version digits in the model id rather than an id
 * allowlist so custom Settings-entered ids of the same generation
 * resolve correctly. Ids without parseable digits default to adaptive —
 * every model Anthropic ships going forward takes that shape.
 *
 * @param {string} model
 * @returns {boolean} true → `{ type: 'adaptive' }`; false → enabled+budget
 */
export const usesAdaptiveThinking = (model) => {
  const nums = String(model).match(/\d+/g);
  if (!nums || nums.length === 0) return true;
  const major = Number(nums[0]);
  // why: a 4+-digit second group is a date stamp, not a minor version
  // (claude-haiku-4-5-20251001 → ['4','5','20251001']; claude-fable-5
  // has no minor at all). Treat it as minor 0.
  const minor = nums.length > 1 && nums[1].length < 4 ? Number(nums[1]) : 0;
  return major > 4 || (major === 4 && minor >= 6);
};

/**
 * Build the JSON body for a /v1/messages call. Pure.
 *
 * Prompt caching: three of the four available cache_control:ephemeral
 * breakpoints are used.
 *
 *   1. system prompt        — stable across the whole conversation
 *   2. tool definitions     — stable across the whole conversation
 *   3. message history      — stable across all turns BEFORE the
 *                              current user message (see below)
 *
 * Without breakpoint (3), every previously-streamed assistant message
 * and every previously-emitted tool_result block gets re-billed at
 * 100% on every turn — and tool_result content (a `read_page` body,
 * a `vm_boot` stdout dump) is where the volume actually lives. With
 * (3), only the newest user message + the new assistant turn are
 * fresh; everything before is cached at ~10% cost.
 *
 * Placement of (3): on the LAST message in the converted-Anthropic
 * shape. Cache breakpoints mark everything UP TO and INCLUDING the
 * block they sit on as cacheable. Putting it on the last message
 * means the entire prior conversation (including the just-appended
 * user message that triggered this call) lands in cache for the
 * NEXT turn.
 *
 * @param {Object} args
 * @param {string} args.model
 * @param {string} args.system
 * @param {readonly InternalMessage[]} args.messages
 * @param {ReadonlyArray<{ name: string, description: string, schema: object }>} [args.tools]
 * @param {number} [args.maxTokens]
 * @param {{ enabled?: boolean, budgetTokens?: number, effort?: 'low'|'medium'|'high'|'xhigh'|'max' }} [args.reasoning]
 *   Extended-thinking control. When `enabled`, emit Anthropic's
 *   `thinking` param so the model streams a reasoning block, and replay
 *   persisted thinking blocks from history (signature-matched). Default
 *   off — no behavioural change.
 */
// why 64000: peerd ALWAYS streams, so the ceiling costs nothing unless
// used — and adaptive thinking (the 4.6+/Fable default mode) draws its
// thinking tokens FROM max_tokens with no budget knob. The old 4096
// default starved hard prompts: the model burned the whole ceiling
// reasoning and got truncated (stop_reason max_tokens) before emitting
// a single tool_use — observed in the field as a "silent timeout".
// 64000 is the platform-recommended streaming default and within every
// current model's streamed output cap. Explicit maxTokens (e.g. the
// subagent output cap) still wins.
export const toAnthropicBody = ({ model, system, messages, tools, maxTokens = 64000, reasoning }) => {
  const thinkingEnabled = !!reasoning?.enabled;
  const wireMessages = toAnthropicMessages(messages, thinkingEnabled);
  // why: tag the last content block of the last message with
  // cache_control. Two shapes possible — string content (gets wrapped
  // into a single text block so the breakpoint can attach) or array
  // content (the last block gets the breakpoint inline). Idempotent
  // for the array shape because content blocks are typed objects.
  if (wireMessages.length > 0) {
    const last = wireMessages[wireMessages.length - 1];
    if (typeof last.content === 'string') {
      last.content = [{
        type: 'text',
        text: last.content,
        cache_control: { type: 'ephemeral' },
      }];
    } else if (Array.isArray(last.content) && last.content.length > 0) {
      const tail = last.content[last.content.length - 1];
      tail.cache_control = { type: 'ephemeral' };
    }
  }
  // why: thinking tokens draw from the max_tokens ceiling on every
  // model, so lift it whenever thinking is on — otherwise the visible
  // answer gets starved by the reasoning. On the legacy enabled shape
  // this is additionally a hard API rule (max_tokens must exceed
  // budget_tokens or the request 400s).
  const budgetTokens = thinkingEnabled
    ? Math.max(1024, Math.floor(reasoning?.budgetTokens ?? 2048))
    : 0;
  const effectiveMaxTokens = thinkingEnabled
    ? Math.max(maxTokens, budgetTokens + 4096)
    : maxTokens;

  /** @type {Record<string, any>} */
  const body = {
    model,
    max_tokens: effectiveMaxTokens,
    messages: wireMessages,
    stream: true,
  };
  // Effort (GA on 4.6+/Fable): the only bound on ADAPTIVE thinking depth
  // (budget_tokens is removed there). Pass-through when the caller sets
  // it; absent = the platform default (high).
  if (typeof reasoning?.effort === 'string' && reasoning.effort) {
    body.output_config = { effort: reasoning.effort };
  }
  // why: an empty/whitespace system prompt must OMIT the field — the
  // API rejects empty text blocks, so emitting the block form with
  // text:'' 400s the request (this broke the 1-token provider key
  // check, which sends system:''). The cache breakpoint goes with it;
  // there's nothing to cache.
  if (typeof system === 'string' && system.trim().length > 0) {
    // System as a single-block array with cache_control. The API also
    // accepts a plain string here; we use the array form purely so we
    // can attach the cache breakpoint.
    body.system = [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
    ];
  }
  if (thinkingEnabled) {
    // Model-keyed shape — see usesAdaptiveThinking. Adaptive takes no
    // budget; the model decides depth per request.
    body.thinking = usesAdaptiveThinking(model)
      ? { type: 'adaptive' }
      : { type: 'enabled', budget_tokens: budgetTokens };
  }
  if (Array.isArray(tools) && tools.length > 0) {
    const last = tools.length - 1;
    body.tools = tools.map((t, i) => {
      /** @type {{ name: string, description: string, input_schema: object, cache_control?: { type: 'ephemeral' } }} */
      const entry = {
        name: t.name,
        description: t.description,
        input_schema: t.schema ?? { type: 'object', properties: {} },
      };
      // Cache breakpoint on the LAST tool caches every tool entry above
      // it as well. Combined with the system + last-message breakpoints,
      // we use 3 of Anthropic's 4 available per-request cache_controls.
      // The fourth is held in reserve for messages-history pinning at
      // a deeper point (e.g. a sliding-window anchor) if we add it later.
      if (i === last) entry.cache_control = { type: 'ephemeral' };
      return entry;
    });
  }
  return body;
};
