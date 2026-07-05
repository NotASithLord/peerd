// web/agent.js — a minimal local agent loop for peerd-lite.
//
// Mirrors how the extension drives the model: a conversation + a tool surface,
// streamed generation, parse the model's <tool_call> blocks (the same format
// the extension's local-webgpu adapter parses), execute them, feed the results
// back, and loop until the model answers with plain text. The model is Gemma,
// running locally (web/gemma.js). Tool execution is injected by the host
// (index.html) so this file owns no DOM and no peerd internals.

const TOOL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
// Degenerate forms small models actually emit (observed live from Gemma 3n):
//   call:run_notebook{code:// raw js ... }
//   run_notebook{ "code": "..." }        (missing wrapper tags)
//   <tool_call>{name:'x', arguments:{…}} (unquoted keys / single quotes)
// The lenient pass recognizes the ATTEMPT, extracts what it can, and the loop
// gives the model ONE corrective retry when extraction fails — a small local
// model corrects reliably when the error is fed back explicitly.
const LENIENT_RE = /(?:call:|<tool_call>?\s*)?\b(run_notebook|show_peers)\b\s*[({]/;

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
    } catch { /* malformed JSON inside tags — the lenient pass may still catch it */ }
  }
  return calls;
}

// Best-effort extraction from a degenerate attempt. Returns
//   { calls: [...] }          when something usable was recovered,
//   { attempted: true }       when a tool was clearly attempted but unusable,
//   null                      when the text is just prose.
function parseLenient(text) {
  const m = LENIENT_RE.exec(text);
  if (!m) return null;
  const name = m[1];
  if (name === 'show_peers') return { calls: [{ name, arguments: {} }] };
  // run_notebook: pull the code out of the outermost braces after the name.
  const braceStart = text.indexOf('{', m.index);
  const braceEnd = text.lastIndexOf('}');
  if (braceStart < 0 || braceEnd <= braceStart) return { attempted: true };
  let body = text.slice(braceStart + 1, braceEnd).trim();
  // peel a {"code": "..."} / {code: ...} wrapper down to the code itself
  const labeled = body.match(/^["']?(?:code|arguments)["']?\s*:\s*([\s\S]*)$/);
  if (labeled) body = labeled[1].trim();
  // nested {"code": "..."} after an arguments label
  const nested = body.match(/^\{\s*["']?code["']?\s*:\s*([\s\S]*)\}\s*$/);
  if (nested) body = nested[1].trim();
  // a properly quoted JS string → unquote via JSON; otherwise treat as raw JS
  if (/^"/.test(body)) { try { body = JSON.parse(body.replace(/,\s*$/, '')); } catch { /* keep raw */ } }
  body = String(body).trim();
  if (!body) return { attempted: true };
  // single-line code opening with a comment = the WHOLE program is commented
  // out (models flatten multi-line code when they skip the JSON quoting) —
  // running it would silently do nothing; force the corrective retry instead.
  if (!body.includes('\n') && /^\/\//.test(body)) return { attempted: true };
  return { calls: [{ name, arguments: { code: body } }] };
}

const RETRY_NUDGE = 'error: malformed tool call. Emit EXACTLY this format, nothing else around it: '
  + '<tool_call>{"name":"run_notebook","arguments":{"code":"const x = 2 + 2; console.log(x); return x;"}}</tool_call>';

const stripToolCalls = (text) => text.replace(TOOL_RE, '').trim();
// when the lenient parser consumed the message, nothing model-said is chat-worthy
const stripLenient = (text) => text.slice(0, (LENIENT_RE.exec(text)?.index ?? text.length)).trim();

// Numeric-overflow tripwire: a saturated fp16 WebGPU backend degenerates into
// one repeated token ("!!!!…", "<unused56><unused56>…"). Catch it before it
// reaches the user — the reply is garbage, not an answer.
export function looksGarbled(text) {
  const t = (text || '').trim();
  if (t.length < 24) return false;
  const runs = t.match(/(.)\1{23,}/);                       // 24+ of the same char
  if (runs) return true;
  const uniq = new Set(t.replace(/\s/g, '').split(''));
  if (t.length >= 48 && uniq.size <= 3) return true;        // long text, ≤3 distinct chars
  return /(?:<unused\d+>\s*){4,}/.test(t);                  // repeated filler tokens
}

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
   *          onToolResult?: (c: object, result: string) => void,
   *          onRetry?: (malformed: string) => void }} [hooks]
   */
  async function chat(userText, hooks = {}) {
    conversation.push({ role: 'user', content: userText });
    for (let turn = 0; turn < maxTurns; turn++) {
      let full = '';
      await generate({ messages: conversation, system, tools }, (t) => {
        full += t;
        hooks.onDelta && hooks.onDelta(stripToolCalls(full));
      });
      let calls = parseToolCalls(full);
      let visible = stripToolCalls(full);

      // Strict parse found nothing — check for a degenerate attempt before
      // treating the text as a final answer (observed live: Gemma emitting
      // `call:run_notebook{code:…}`; without this the attempt leaks into chat).
      if (calls.length === 0) {
        const lenient = parseLenient(full);
        if (lenient?.calls) {
          calls = lenient.calls;
          visible = stripLenient(full);
        } else if (lenient?.attempted) {
          // clearly tried, nothing recoverable → ONE corrective retry: feed the
          // exact format back as an error result (costs a turn from maxTurns).
          conversation.push({ role: 'assistant', content: full });
          conversation.push({ role: 'user', content: [{ type: 'tool_result', content: RETRY_NUDGE }] });
          hooks.onRetry && hooks.onRetry(full);
          continue;
        }
      }

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
        catch (e) { result = `error: ${  e?.message || String(e)}`; }
        result = typeof result === 'string' ? result : JSON.stringify(result);
        hooks.onToolResult && hooks.onToolResult(c, result);
        results.push({ type: 'tool_result', content: result });
      }
      conversation.push({ role: 'user', content: results });
    }
    hooks.onText && hooks.onText(`(stopped after ${  maxTurns  } tool turns)`);
    return null;
  }

  return { chat, conversation };
}
