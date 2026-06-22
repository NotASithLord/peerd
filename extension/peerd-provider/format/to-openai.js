// @ts-check
// Internal message shape → OpenAI-compatible /chat/completions body.
//
// Used by the OpenRouter adapter (and any future OpenAI / Ollama
// adapter — they share this wire format). The internal union is the same
// one to-anthropic.js consumes; only the target shape differs.
//
// OpenAI message shapes:
//   - system:    { role:'system', content }
//   - user text: { role:'user', content }
//   - assistant: { role:'assistant', content: string|null,
//                  tool_calls?: [{ id, type:'function',
//                                  function:{ name, arguments:<JSON string> } }] }
//   - tool result: { role:'tool', tool_call_id, content }   (ONE per result)
//
// Unlike Anthropic, OpenAI carries tool results as their OWN top-level
// messages (role:'tool'), not as blocks inside a user message. Every
// assistant tool_call id MUST be followed by a matching tool message or
// the API 400s — same orphan hazard as Anthropic, repaired below.

/** @typedef {import('../types.js').InternalMessage} InternalMessage */
/** @typedef {import('../types.js').UserMessage} UserMessage */
/** @typedef {import('../types.js').ToolUseBlock} ToolUseBlock */
/** @typedef {import('../types.js').Attachment} Attachment */

/**
 * @typedef {Object} OpenAiToolCall
 * @property {string} id
 * @property {'function'} type
 * @property {{ name: string, arguments: string }} function
 */

/**
 * One content part of a multimodal user message. OpenAI carries vision input
 * as an array of parts: text + image_url (a data: URL or https URL). There is
 * no document part — PDFs are Anthropic-only.
 * @typedef {{ type: 'text', text: string }
 *        | { type: 'image_url', image_url: { url: string } }} OpenAiContentPart
 */

/**
 * One OpenAI /chat/completions wire message. The shape varies by role —
 * `tool_calls` rides assistant turns, `tool_call_id` rides tool results,
 * and a user message with image attachments carries a content-part ARRAY.
 * @typedef {Object} OpenAiMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string | null | OpenAiContentPart[]} [content]
 * @property {OpenAiToolCall[]} [tool_calls]
 * @property {string} [tool_call_id]
 */

/**
 * @param {ToolUseBlock[]} toolUses
 * @returns {OpenAiToolCall[]}
 */
const toToolCalls = (toolUses) =>
  toolUses.map((tu) => ({
    id: tu.id,
    type: 'function',
    function: {
      name: tu.name,
      arguments: JSON.stringify(tu.input ?? {}),
    },
  }));

// A one-line trace for an attachment that can't ride the OpenAI wire on THIS
// turn — a stripped record (its bytes already shipped on the turn it was sent,
// the send-once contract) or a PDF (OpenAI chat completions has no document
// part; PDFs are Anthropic-only). Keeps the model aware the file existed
// without the bytes, mirroring to-anthropic.js's stripped sentinel.
/** @param {Attachment} a */
const attachmentNote = (a) => {
  const name = String(a.name ?? 'file').replace(/[<>"]/g, '');
  return a.stripped
    ? `<attachment "${name}" (${a.mediaType}) ${a.size}B — sent on its original turn>`
    : `<attachment "${name}" (${a.mediaType}) — PDFs are only sent on the Anthropic provider; omitted here>`;
};

/** @param {Attachment} a */
const isLiveImage = (a) =>
  !a?.stripped && a.kind === 'image' && typeof a.data === 'string' && a.data.length > 0;

/**
 * Build the OpenAI `content` for a user message. Live image attachments become
 * `image_url` parts (OpenAI vision); the text — plus a one-line note for any
 * stripped or PDF attachment — leads as a text part. Falls back to a plain
 * string when there are no live images, keeping the common case compact.
 *
 * @param {UserMessage} m
 * @returns {string | OpenAiContentPart[]}
 */
const userContent = (m) => {
  const text = typeof m.content === 'string' ? m.content : '';
  /** @type {Attachment[]} */
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  const liveImages = atts.filter(isLiveImage);
  const notes = atts
    .filter((a) => (a?.stripped && (a.kind === 'image' || a.kind === 'pdf'))
      || (!a?.stripped && a.kind === 'pdf' && typeof a.data === 'string' && a.data.length > 0))
    .map(attachmentNote);
  const fullText = [...notes, ...(text.length > 0 ? [text] : [])].join('\n');
  if (liveImages.length === 0) return fullText;
  /** @type {OpenAiContentPart[]} */
  const parts = [];
  if (fullText.length > 0) parts.push({ type: 'text', text: fullText });
  for (const a of liveImages) {
    parts.push({ type: 'image_url', image_url: { url: `data:${a.mediaType};base64,${a.data}` } });
  }
  return parts;
};

/**
 * Map internal messages to the OpenAI messages array. The `system`
 * prompt is prepended as a system message (OpenAI has no separate
 * system field the way Anthropic does).
 *
 * @param {string} system
 * @param {readonly InternalMessage[]} messages
 * @returns {OpenAiMessage[]}
 */
const toOpenAiMessages = (system, messages) => {
  /** @type {OpenAiMessage[]} */
  const out = [];
  if (typeof system === 'string' && system.length > 0) {
    out.push({ role: 'system', content: system });
  }
  for (const m of messages) {
    if (m.role === 'assistant') {
      const hasTools = Array.isArray(m.toolUses) && m.toolUses.length > 0;
      const hasText = typeof m.content === 'string' && m.content.length > 0;
      if (!hasTools && !hasText) continue;  // empty assistant — drop
      /** @type {OpenAiMessage} */
      const msg = { role: 'assistant', content: hasText ? m.content : null };
      if (hasTools && m.toolUses) msg.tool_calls = toToolCalls(m.toolUses);
      out.push(msg);
    } else if (m.role === 'user') {
      if (Array.isArray(m.toolResults) && m.toolResults.length > 0) {
        for (const tr of m.toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
      } else {
        const content = userContent(m);
        // Skip a truly empty user message (no text, no live image, no note).
        if ((typeof content === 'string' && content.length > 0)
            || (Array.isArray(content) && content.length > 0)) {
          out.push({ role: 'user', content });
        }
      }
    }
  }
  return repairOrphanToolCalls(out);
};

/**
 * Ensure every assistant tool_call id is immediately followed by a
 * matching tool message. If a turn ended mid-dispatch (SW restart,
 * abort) the history can carry tool_calls with no results; OpenAI 400s
 * on that. We synthesize an error tool message for each orphan. Wire-
 * format-only — the persisted session is untouched.
 *
 * @param {OpenAiMessage[]} msgs
 * @returns {OpenAiMessage[]}
 */
const repairOrphanToolCalls = (msgs) => {
  /** @type {OpenAiMessage[]} */
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    out.push(m);
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    // Collect the tool ids already satisfied by the following run of
    // tool messages.
    const satisfied = new Set();
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === 'tool') {
      satisfied.add(msgs[j].tool_call_id);
      j++;
    }
    for (const tc of m.tool_calls) {
      if (!satisfied.has(tc.id)) {
        out.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: 'tool dispatch did not complete. Treat as failed and retry if needed.',
        });
      }
    }
  }
  return out;
};

/**
 * Build the /chat/completions request body. Pure.
 *
 * @param {Object} args
 * @param {string} args.model
 * @param {string} args.system
 * @param {readonly InternalMessage[]} args.messages
 * @param {ReadonlyArray<{ name: string, description: string, schema: object }>} [args.tools]
 * @param {number} [args.maxTokens]
 * @returns {object}
 */
export const toOpenAiBody = ({ model, system, messages, tools, maxTokens = 4096 }) => {
  /** @type {Record<string, any>} */
  const body = {
    model,
    messages: toOpenAiMessages(system, messages),
    max_tokens: maxTokens,
    stream: true,
    // why: opt into the final usage chunk so from-openai.js can emit a
    // `usage` event for cost telemetry (feature 06). Without this,
    // OpenAI/OpenRouter streams carry NO token counts at all and the
    // meter would read zero for every OpenRouter turn.
    stream_options: { include_usage: true },
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema ?? { type: 'object', properties: {} },
      },
    }));
    body.tool_choice = 'auto';
  }
  return body;
};

// Test seam — exercise the message mapper + orphan repair directly.
export const _toOpenAiMessagesForTests = toOpenAiMessages;
