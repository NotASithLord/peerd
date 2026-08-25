import { describe, expect, test } from 'bun:test';
import { executeControllerToolCall } from '../../extension/offscreen/controller-tool-runtime.js';
import { CONTROLLER_TOOL_MANIFEST } from '../../extension/shared/controller-tool-manifest.js';
import { TOOL_EXECUTION_PROTOCOL } from '../../extension/shared/tool-execution-protocol.js';

const request = (over: Record<string, unknown> = {}) => ({
  protocol: TOOL_EXECUTION_PROTOCOL,
  executionId: 'execution-now-1',
  runId: 'run-now-1',
  callId: 'call-now-1',
  sessionId: 'session-now-1',
  turnGeneration: 1,
  attempt: 0,
  toolName: 'now',
  argsDigest: 'a'.repeat(64),
  manifestDigest: CONTROLLER_TOOL_MANIFEST.digest,
  args: {},
  projection: {},
  ...over,
});

const options = () => ({
  signal: new AbortController().signal,
  authority: {
    ownerId: 'run-now-1',
    sessionId: 'session-now-1',
    target: 'tool:now',
    replayClass: 'E',
  },
  deadlineAt: Date.now() + 5_000,
});

describe('controller tool runtime', () => {
  test('executes a pure tool without a kernel effect channel', async () => {
    const result = await executeControllerToolCall(request(), options());
    expect(result).toMatchObject({
      ok: true,
      outcomeKnown: true,
      effectEntered: false,
      executionId: 'execution-now-1',
    });
    const value = JSON.parse(result.value.content);
    expect(value.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(value.unixMs).toBeNumber();
    expect(value.timezone).toBeString();
    expect(value.dayOfWeek).toBeString();
  });

  test('rejects tools outside the compiled manifest', async () => {
    const result = await executeControllerToolCall(
      request({ toolName: 'remember' }),
      { ...options(), authority: { ...options().authority, target: 'tool:remember' } },
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'tool-execution-request-invalid',
      outcomeKnown: true,
      effectEntered: false,
    });
  });
});
