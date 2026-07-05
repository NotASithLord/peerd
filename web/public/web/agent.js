// web/agent.js — a minimal local agent loop for peerd-lite.
//
// Mirrors how the extension drives the model: a conversation + a tool surface,
// streamed generation, parse the model's <tool_call> blocks (the same format
// the extension's local-webgpu adapter parses), execute them, feed the results
// back, and loop until the model answers with plain text. The model is Gemma,
// running locally (web/gemma.js). Tool execution is injected by the host
// (index.html) so this file owns no DOM and no peerd internals.

const TOOL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

function parseToolCalls(text) {
  const calls = [];
  let m;
  TOOL_RE.lastIndex = 0;
  while ((m = TOOL_RE.exec(text))) {
    try {
      const obj = JSON.parse(m[1]);
      const name = obj.name || obj.tool;
      const args = obj.arguments ?? obj.args ?? obj.parameters ?? {};
      if (name) calls.push({ name, arguments: args });
    } catch { /* malformed tool_call — ignore, treat as text */ }
  }
  return calls;
}
const stripToolCalls = (text) => text.replace(TOOL_RE, '').trim();

/**
 * @param {{
 *   generate: (req: object, onToken: (t: string) => void) => Promise<void>,
 *   runTool: (name: string, args: object) => Promise<string> | string,
 *   tools: readonly object[],
 *   system: string,
 *   maxTurns?: number,
 * }} cfg
 */
export function makeAgent({ generate, runTool, tools, system, maxTurns = 4 }) {
  const conversation = [];

  /**
   * @param {string} userText
   * @param {{ onDelta?: (visible: string) => void, onText?: (final: string) => void,
   *          onToolCall?: (c: {name:string,arguments:object}) => void,
   *          onToolResult?: (c: object, result: string) => void }} [hooks]
   */
  async function chat(userText, hooks = {}) {
    conversation.push({ role: 'user', content: userText });
    for (let turn = 0; turn < maxTurns; turn++) {
      let full = '';
      await generate({ messages: conversation, system, tools }, (t) => {
        full += t;
        hooks.onDelta && hooks.onDelta(stripToolCalls(full));
      });
      const calls = parseToolCalls(full);
      const visible = stripToolCalls(full);

      if (calls.length === 0) {
        conversation.push({ role: 'assistant', content: full });
        hooks.onText && hooks.onText(visible || full);
        return visible || full;
      }

      conversation.push({
        role: 'assistant',
        content: [
          ...(visible ? [{ type: 'text', text: visible }] : []),
          ...calls.map((c) => ({ type: 'tool_use', name: c.name, input: c.arguments })),
        ],
      });
      if (visible) hooks.onText && hooks.onText(visible);

      const results = [];
      for (const c of calls) {
        hooks.onToolCall && hooks.onToolCall(c);
        let result;
        try { result = await runTool(c.name, c.arguments || {}); }
        catch (e) { result = 'error: ' + (e?.message || String(e)); }
        result = typeof result === 'string' ? result : JSON.stringify(result);
        hooks.onToolResult && hooks.onToolResult(c, result);
        results.push({ type: 'tool_result', content: result });
      }
      conversation.push({ role: 'user', content: results });
    }
    hooks.onText && hooks.onText('(stopped after ' + maxTurns + ' tool turns)');
    return null;
  }

  return { chat, conversation };
}
