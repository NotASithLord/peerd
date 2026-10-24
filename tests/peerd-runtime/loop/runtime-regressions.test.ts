import { expect, test } from 'bun:test';
import { runUserTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';
import { fromOpenAiStream } from '../../../extension/peerd-provider/format/from-openai.js';
import { createSessionStore } from '../../../extension/peerd-runtime/sessions/store.js';
import { makeMockIdb } from '../../../extension/tests/mocks/idb.js';
import { executeControllerIntrospectionTool } from '../../../extension/peerd-runtime/controller-introspection-tools.js';
import { executeControllerPersistenceTool } from '../../../extension/peerd-runtime/controller-persistence-tools.js';
import { createMemoryStore } from '../../../extension/peerd-runtime/memory/store.js';
import { parseSkillDocument } from '../../../extension/shared/skill-document.js';
import { PAGED_MAX_CHARS } from '../../../extension/peerd-runtime/tools/web/spill.js';

test.each(['{"url":"cut', '{"url":"https://example.test/"}}', "{'url':'x'}", '{"code":"line one\nline two"}', '"encoded"', '[]', 'true', 'null'])(
  'invalid arguments %s never dispatch and stay honest in replay', async (argumentsText) => {
    const sessions = createSessionStore({ idb: makeMockIdb() });
    const session = await sessions.create();
    const dispatched: any[] = [], audits: any[] = [], requests: any[] = [];
    let calls = 0;
    const callModel = (request: any) => {
      requests.push(structuredClone(request.messages));
      const toolCalls = [argumentsText, '{"url":"https://example.test/"}', ''].map((args, index) => ({
        index, id: `call-${index}`, type: 'function', function: { name: 'open_tab', arguments: args },
      }));
      const chunks = calls++ === 0 ? [
        { choices: [{ delta: { tool_calls: toolCalls } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ] : [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }];
      return fromOpenAiStream(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'));
        controller.close();
      } }));
    };
    for await (const _ of runUserTurn({
      sessionId: session.sessionId, userText: 'open the requested pages', sessions,
      callModel, getSecret: async () => '', safeFetch: async () => new Response(), getSystemPrompt: async () => '',
      appendAudit: async (entry: any) => { audits.push(entry); },
      tools: [{ name: 'open_tab', description: 'Open a tab', schema: {} }],
      toolDispatch: async (call) => { dispatched.push(call); return { ok: true, content: 'opened' }; },
    })) { /* consume the real provider and loop */ }
    expect(dispatched.map((call) => call.id)).toEqual(['call-1', 'call-2']);
    expect(dispatched.map((call) => call.args)).toEqual([{ url: 'https://example.test/' }, {}]);
    const replay = requests[1];
    const result = replay.flatMap((message: any) => message.toolResults ?? []).find((row: any) => row.tool_use_id === 'call-0');
    expect(result.is_error).toBe(true);
    expect(result.content.startsWith('invalid_arguments:')).toBe(true);
    expect(result.content).toContain('Nothing ran. Resend the call with complete JSON.');
    expect(result.outcomeKnown).not.toBe(false);
    expect(replay.flatMap((message: any) => message.toolUses ?? [])[0].input).toEqual({});
    expect(audits.filter((entry) => entry.type === 'tool_failed')).toMatchObject([
      { details: { tool: 'open_tab', kind: 'invalid_arguments' } },
    ]);
  },
);

test.each(['skill', 'project', 'subtree'] as const)('%s pages reach the real loop with no missing middle', async (kind) => {
  const idb = makeMockIdb();
  const sessions = createSessionStore({ idb });
  const session = await sessions.create();
  const memory = createMemoryStore({ idb });
  const body = Array.from({ length: kind === 'skill' ? 120 : 300 }, (_, index) =>
    `Step ${index}: ${'Keep this instruction. '.repeat(kind === 'skill' ? 20 : 2)}`.trimEnd()).join('\n');
  const skill = parseSkillDocument(`---\nname: paging-fixture\ndescription: Check every instruction.\n---\n${body}`);
  const scope = { kind: kind === 'subtree' ? 'subtree' as const : 'project' as const, workspace: 'https://example.test', subpath: kind === 'subtree' ? 'src' : '' };
  if (kind !== 'skill') await memory.commitWrite(await memory.proposeWrite({ scope, body, origin: 'user' }));
  const toolName = kind === 'skill' ? 'load_skill' : 'read_memory';
  let next: any = kind === 'skill' ? { name: skill.name } : { scope: kind, workspace: scope.workspace, ...(kind === 'subtree' ? { subpath: 'src' } : {}) };
  const pages: string[] = [];
  let sequence = 0;
  for await (const _ of runUserTurn({
    sessionId: session.sessionId, userText: 'Read every instruction.', sessions,
    getSecret: async () => '', safeFetch: async () => new Response(), getSystemPrompt: async () => '', appendAudit: async () => {},
    tools: [{ name: toolName, description: 'Read the instructions', schema: {} }],
    callModel: async function* ({ messages }: any) {
      const previous = messages.flatMap((message: any) => message.toolResults ?? []).at(-1);
      if (previous) {
        expect(previous.is_error).toBe(false);
        expect(previous.content).not.toContain(' chars elided ');
        expect(previous.content.length).toBeLessThanOrEqual(PAGED_MAX_CHARS);
        pages.push(previous.content);
        const continuation = previous.content.match(/next: (.+)\.$/m);
        if (!continuation) { yield { type: 'message-stop', stopReason: 'end_turn' }; return; }
        next = JSON.parse(continuation[1]);
      }
      const id = `page-${sequence++}`;
      yield { type: 'tool-use-start', id, name: toolName };
      yield { type: 'tool-use-delta', id, partialJson: JSON.stringify(next) };
      yield { type: 'tool-use-stop', id };
      yield { type: 'message-stop', stopReason: 'tool_use' };
    },
    toolDispatch: async (call) => {
      const current = await sessions.get(session.sessionId);
      const result = kind === 'skill' ? await executeControllerIntrospectionTool('load_skill', call.args, {
        sessionId: session.sessionId, messageCount: current!.messages.length,
        trimCovered: current!.trimSummary?.covered ?? 0, messages: current!.messages,
      }, { readInstalledSkill: async () => ({ meta: skill, body: skill.body }) })
        : await executeControllerPersistenceTool('read_memory', call.args, { sessionId: session.sessionId }, {
          readMemoryScope: memory.readScope, readMemorySubtree: memory.readSubtree,
        });
      return { ...result, meta: { toolName, primitive: 'inspect', gates: [], durationMs: 0 } } as any;
    },
  })) { /* use the real result persistence and redaction path */ }
  const restored = pages.map((content) => kind === 'skill'
    ? content.match(/\n\n([\s\S]*)\n<\/skill>/)![1]
    : content.replace(/\n\[paging\][^\n]*$/, '')).join('');
  expect(restored).toBe(kind === 'subtree' ? `### src\n${body}` : body);
  expect(pages.length).toBeGreaterThan(1);
});
