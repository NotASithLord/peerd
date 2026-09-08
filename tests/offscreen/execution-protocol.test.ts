import { describe, expect, test } from 'bun:test';
import { describeActorExecution } from '../../extension/offscreen/actor-runner.js';
import { describeCodeExecution } from '../../extension/offscreen/job-runner.js';
import {
  AGENT_PROGRAM,
  EXECUTION_PROTOCOL,
  JAVASCRIPT_PROGRAM,
  isExecutionDescription,
} from '../../extension/shared/execution-protocol.js';

describe('common execution protocol', () => {
  test('describes agent and deterministic programs with one cloneable shape', () => {
    const agent = describeActorExecution({
      actorSessionId: 'actor-1',
      message: 'inspect the page',
      systemPrompt: 'system',
      provider: 'anthropic',
      model: 'model',
      priorMessages: [{ role: 'assistant', content: 'prior state' }],
      tools: [{ name: 'snapshot', description: 'read', schema: {} }],
      actorType: 'web',
    }, 'agent-run');
    const code = describeCodeExecution({
      code: 'return 6 * 7;',
      ownerSessionId: 'chat-1',
      workspaceSessionId: 'chat-1',
      actors: true,
    }, 'code-run', { egress: false, opfs: true });

    for (const execution of [agent, code]) {
      expect(execution.protocol).toBe(EXECUTION_PROTOCOL);
      expect(isExecutionDescription(execution)).toBe(true);
      expect(() => structuredClone(execution)).not.toThrow();
    }
    expect(agent).toMatchObject({
      id: 'agent-run',
      program: { kind: AGENT_PROGRAM },
      input: 'inspect the page',
      state: { messages: [{ role: 'assistant', content: 'prior state' }] },
      capabilities: ['model', 'snapshot'],
      metadata: { sessionId: 'actor-1', actorType: 'web' },
    });
    expect(code).toMatchObject({
      id: 'code-run',
      program: { kind: JAVASCRIPT_PROGRAM, source: 'return 6 * 7;' },
      state: { workspaceSessionId: 'chat-1' },
      capabilities: ['opfs', 'actors', 'workspace'],
      metadata: { ownerSessionId: 'chat-1' },
    });
  });

  test('program text does not imply authority', () => {
    const execution = describeCodeExecution({
      code: 'return fetch("https://example.com");',
      workspaceSessionId: 'chat-1',
    }, 'no-egress', { egress: false, opfs: false });

    expect(execution.capabilities).toEqual([]);
    expect(execution.state).toEqual({ workspaceSessionId: 'chat-1' });
  });
});
